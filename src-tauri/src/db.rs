// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use crate::state::{
    AttachState, BrowseHarness, BrowseList, BrowseListItem, BrowseMessage, CodeReviewSession,
    Comment, CommentAttachment,
    CommentKind, CommentOffer, ResearchLink,
    CommentScope, CommentSelection, CommentStatus, EditPayload, Mission,
    MissionFinding, MissionMessage, PushRecord, Resolution, ReviewAnnotation, ReviewQuestion,
    ReviewSession, Revision, RoundHistoryEntry, SessionStatus, StructuralPayload,
    ThreadMessage, VoiceMessage,
};

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
/// A research link as stored: NULL for every non-research comment.
fn research_to_json(link: Option<&ResearchLink>) -> Option<String> {
    link.and_then(|l| serde_json::to_string(l).ok())
}

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

/// `(seq, kind, session_id, comment body)`: one row of `recent_decisions`.
pub type DecisionRow = (i64, String, Option<String>, Option<String>);

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

/// The ready frontier's shape, shared by `list_ready_work_items` (the page)
/// and `count_ready_work_items` (the pill's count) so the two can't drift.
/// Binds `?1` = project filter (NULL = all) and `?2` = now (ms).
const READY_WORK_CTE: &str = "WITH RECURSIVE deferred_down(id) AS (
                 SELECT id FROM work_items
                  WHERE defer_until IS NOT NULL AND defer_until > ?2
                 UNION
                 SELECT e.to_id FROM work_edges e
                  JOIN deferred_down d ON e.from_id = d.id
                  WHERE e.type = 'parent-child'
             )";
const READY_WORK_WHERE: &str = "w.status = 'open'
               AND (?1 IS NULL OR w.project_path = ?1)
               AND w.id NOT IN (SELECT id FROM deferred_down)
               AND NOT EXISTS (
                   SELECT 1 FROM work_edges e
                    JOIN work_items b ON b.id = e.from_id
                   WHERE e.to_id = w.id AND e.type = 'blocks'
                     AND b.status != 'closed'
               )";


pub struct Database {
    /// Shared with the attached `PolisStore` — ONE connection, one lock, so
    /// the memory tables and the app's own live in one transaction domain.
    /// Every write goes through it.
    conn: Arc<Mutex<Connection>>,
    /// Read-only connections on the same file, for `read_conn`. `None` for an
    /// in-memory database (a second connection can't see it) and for a file
    /// not in WAL mode (its readers would block the writer).
    readers: Option<Readers>,
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

/// How many read connections a file database keeps. Reads are short; a few
/// cover the UI, the daemon and the keeper reading at once, and each one
/// costs a page cache.
const READERS: usize = 3;

/// The read connections. WAL lets each read a committed snapshot while the
/// writer holds `conn`, so a poll, a bridge route or a keeper pass no longer
/// queues behind a write, a canary or an embedding tick. Each slot opens on
/// the first read that lands on it.
struct Readers {
    path: std::path::PathBuf,
    slots: [Mutex<Option<Connection>>; READERS],
    next: AtomicUsize,
}

impl Readers {
    /// A free slot if there is one, else wait for the next in turn. `None`
    /// only when its connection can't be opened.
    fn take(&self) -> Option<MutexGuard<'_, Option<Connection>>> {
        let start = self.next.fetch_add(1, Ordering::Relaxed);
        let mut slot = (0..READERS)
            .find_map(|i| self.slots[(start + i) % READERS].try_lock().ok())
            // A panic mid-read leaves nothing half-done on a read-only
            // connection, so a poisoned slot is still a good one.
            .unwrap_or_else(|| self.slots[start % READERS].lock().unwrap_or_else(|e| e.into_inner()));
        if slot.is_none() {
            match Self::open(&self.path) {
                Ok(conn) => *slot = Some(conn),
                Err(e) => {
                    tracing::warn!(error = %e, "could not open a read connection; reading on the writer");
                    return None;
                }
            }
        }
        Some(slot)
    }

    fn open(path: &Path) -> rusqlite::Result<Connection> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch(
            "PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -16000; PRAGMA mmap_size = 268435456;",
        )?;
        Ok(conn)
    }
}

/// A connection for one read, from `Database::read_conn`. A write through it
/// fails, whichever connection it is.
///
/// On a reader the read runs in its own transaction, so a read of several
/// statements sees one committed snapshot, as it did holding the writer's
/// lock; dropping the guard ends it, so the next read sees every write that
/// has returned. Without readers it is the writer, made read-only for the
/// length of the read.
pub(crate) enum ReadConn<'a> {
    Reader(MutexGuard<'a, Option<Connection>>),
    Writer(MutexGuard<'a, Connection>),
}

impl std::ops::Deref for ReadConn<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match self {
            Self::Reader(slot) => slot.as_ref().expect("a reader slot is opened before it is lent"),
            Self::Writer(conn) => conn,
        }
    }
}

impl Drop for ReadConn<'_> {
    fn drop(&mut self) {
        let end = match self {
            Self::Reader(_) => "ROLLBACK",
            Self::Writer(_) => "PRAGMA query_only = OFF",
        };
        let _ = self.execute_batch(end);
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
    pub(crate) fn lock_conn(&self) -> MutexGuard<'_, Connection> {
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

    /// A connection for a read: one of the read connections when the file
    /// has them, the writer otherwise. Route a path here only when nothing it
    /// runs writes — a write through it fails — and never while holding
    /// `lock_conn`'s guard (without readers this IS that lock).
    ///
    /// A reader no longer waits for the writer, so it can land between two
    /// statements of one write. A write of more than one statement therefore
    /// runs in one transaction (`unchecked_transaction` on the writer, then
    /// `commit`): a reader sees all of it or none of it.
    pub(crate) fn read_conn(&self) -> ReadConn<'_> {
        if let Some(slot) = self.readers.as_ref().and_then(Readers::take) {
            let read = ReadConn::Reader(slot);
            let _ = read.execute_batch("BEGIN");
            return read;
        }
        let read = ReadConn::Writer(self.lock_conn());
        let _ = read.execute_batch("PRAGMA query_only = ON");
        read
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
        Self::create_side_tables(&conn)?;
        let wal = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .is_ok_and(|mode| mode.eq_ignore_ascii_case("wal"));
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
        let readers = wal.then(|| Readers {
            path: path.to_path_buf(),
            slots: Default::default(),
            next: AtomicUsize::new(0),
        });
        let db = Self { conn, readers, polis: Arc::new(polis) };
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
        Self::create_side_tables(&conn)?;
        let conn = Arc::new(Mutex::new(conn));
        let polis = PolisStore::attach(
            Arc::clone(&conn),
            AttachOptions::redline().with_author(crate::ledger::local_author()),
        )
            .map_err(store_err)?;
        Ok(Self { conn, readers: None, polis: Arc::new(polis) })
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

    /// Tables two modules keep outside the versioned schema
    /// (`browser_workspace`, `monochat`), created on every open rather than
    /// before each use: the `CREATE TABLE IF NOT EXISTS` needs the writer, and
    /// a read that took it first waited out every write. Idempotent, and a
    /// no-op on a database that has them, so no stamp is involved.
    fn create_side_tables(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(crate::browser_workspace::SCHEMA)?;
        conn.execute_batch(crate::monochat::SCHEMA)
    }

    /// The schema version this build writes and expects.
    ///
    /// Bump it and add a step to `MIGRATIONS` in the same diff; never edit a
    /// step that has shipped. Higher stamps are verified without migrations
    /// or restamping; only an unusable forward schema is refused.
    const SCHEMA_VERSION: i64 = 10;

    /// The schema version this build writes, for callers outside `db`.
    ///
    /// Read by the release pipeline, which compares it with the version a
    /// *candidate's* source declares to work out what activating that
    /// candidate would do to the user's stored data.
    pub fn schema_version() -> i64 {
        Self::SCHEMA_VERSION
    }

    /// Ordered migration steps. `(target_version, step)`: running `step` takes
    /// a database from `target_version - 1` to `target_version`.
    const MIGRATIONS: &'static [(i64, fn(&Connection) -> rusqlite::Result<()>)] =
        &[
            (1, Self::migrate_v1),
            (2, Self::migrate_v2),
            (3, Self::migrate_v3),
            (4, Self::migrate_v4),
            (5, Self::migrate_v5),
            (6, Self::migrate_v6),
            (7, Self::migrate_v7),
            (8, Self::migrate_v8),
            (9, Self::migrate_v9),
            (10, Self::migrate_v10),
        ];

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
            Self::migrate_v10(conn)?;
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
            //
            // Except what v5–v9 add, which is applied first: nullable columns
            // and new tables this build owns, all idempotent. A foreign
            // lineage has never heard of them, and refusing over them would
            // brick a database that is otherwise perfectly usable.
            Self::migrate_v5(conn)?;
            Self::migrate_v6(conn)?;
            Self::migrate_v8(conn)?;
            Self::migrate_v9(conn)?;
            Self::migrate_v10(conn)?;
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
            // One exception to "run NO steps": tables this build owns outright
            // and that a foreign lineage has never heard of. `releases` is not
            // in `verify_schema`'s core set — Redline works perfectly well
            // without it, it is just that Build Redline does not — so a
            // forward-stamped database from the cockpit lineage would
            // otherwise reach the feature and fail with "no such table". The
            // step is `CREATE TABLE IF NOT EXISTS` only: over a genuinely
            // newer schema it is a no-op, and it touches nothing that exists.
            Self::migrate_v4(conn)?;
            tracing::warn!(
                stamped = current,
                understood = Self::SCHEMA_VERSION,
                "database carries a newer/foreign schema stamp; schema verified, \
                 creating any missing additive tables and leaving the stamp untouched"
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
        Self::verify_schema_at(conn, Self::SCHEMA_VERSION)
    }

    /// `verify_schema` against the shape a given version promises. A step in
    /// the middle of the chain (v3 verifies itself) must not demand columns a
    /// LATER step adds: a fresh database would fail its own migration.
    fn verify_schema_at(conn: &Connection, version: i64) -> rusqlite::Result<()> {
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
        // Columns later steps add, keyed by the version that adds them.
        const REQUIRED_SINCE: &[(i64, &str, &[&str])] = &[(5, "comments", &["research"]), (6, "companion_sessions", &["project_path"]), (6, "companion_messages", &["meta"]), (6, "change_narrations", &["repo", "fingerprint", "story", "created_at"]), (6, "commit_narrations", &["repo", "sha", "story", "created_at"]), (6, "git_workspaces", &["id", "repo", "path", "branch", "title", "base_sha", "created_at", "state"]), (7, "thread_messages", &["mode"]), (8, "browse_threads", &["backend", "model", "effort", "codex_thread_id", "codex_usage"]), (8, "browse_messages", &["backend"]), (9, "browse_messages", &["target_browse_id"]), (10, "sessions", &["archived_at", "title_override"]), (10, "companion_sessions", &["archived_at"])];
        let later = REQUIRED_SINCE
            .iter()
            .filter(|(since, ..)| *since <= version)
            .map(|(_, table, columns)| (*table, *columns));
        for (table, columns) in REQUIRED.iter().copied().chain(later) {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let present: std::collections::HashSet<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<_>>()?;
            for column in columns {
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

    /// v3 → v4: candidate releases.
    ///
    /// One row per prepared replacement application. Deliberately its own
    /// table rather than columns on `run_graphs`: a release can outlive the run
    /// that produced it, several runs can contribute to one, and "the tasks
    /// finished" is not "there is an installable application". The durable
    /// *activation* state does not live here at all — it is a journal on disk,
    /// because activating a release is one of the few things that can leave
    /// this database unopenable.
    fn migrate_v4(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS releases (
                release_id TEXT PRIMARY KEY,
                run_id TEXT,
                repository TEXT NOT NULL,
                status TEXT NOT NULL,
                candidate_root TEXT NOT NULL,
                bundle_path TEXT,
                manifest_json TEXT,
                capture_json TEXT,
                probe_json TEXT,
                failure TEXT NOT NULL DEFAULT '',
                step TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_releases_run ON releases(run_id);
            CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status, updated_at DESC);
        "#,
        )?;
        Ok(())
    }

    /// v4 → v5: the run-it batch's additions (Tracks S and O).
    ///
    /// * `comments.research`: a research comment's link (Search from the
    ///   plan), JSON `{query, browseId, url?, answerHash?, answerExcerpt?}`;
    ///   NULL for every other comment. The history load reads it, so a
    ///   database without it cannot start.
    /// * `scaled_runs`: a scaled build's config, current limits (Extend
    ///   raises them) and phase, so a restart neither loses the budget nor
    ///   re-opens a stopped build. Additive; no FK (schema law).
    ///
    /// Both first shipped inside `migrate_v1`, which a database already at v4
    /// never runs again: every existing install failed at "no such column:
    /// research". Idempotent, so it is also safe on the forward-stamp path.
    fn migrate_v5(conn: &Connection) -> rusqlite::Result<()> {
        let has_research = {
            let mut stmt = conn.prepare("PRAGMA table_info(comments)")?;
            let columns = stmt
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            // No `comments` table at all is a foreign schema: leave it to
            // `verify_schema` to refuse it with a message, not a raw error.
            columns.is_empty() || columns.iter().any(|c| c == "research")
        };
        if !has_research {
            conn.execute("ALTER TABLE comments ADD COLUMN research TEXT", [])?;
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS scaled_runs (
                run_id TEXT PRIMARY KEY,
                plan_session_id TEXT NOT NULL,
                config_json TEXT NOT NULL,
                limits_json TEXT NOT NULL,
                phase_json TEXT NOT NULL,
                started_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS scaled_runs_by_plan ON scaled_runs(plan_session_id, created_at);
            "#,
        )?;
        Ok(())
    }

    /// Additive v6 workbench and Guided Git state; safe to replay after interruption.
    fn migrate_v6(conn: &Connection) -> rusqlite::Result<()> {
        for (table, column) in [("companion_sessions", "project_path"), ("companion_messages", "meta")] {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
            if !columns.is_empty() && !columns.iter().any(|name| name == column) {
                conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"), [])?;
            }
        }
        crate::guided::migrate(conn)?;
        Ok(())
    }

    /// v6 → v7: `thread_messages.mode`, the sidecar view a discussion turn was
    /// sent from (`"chat"`; NULL is a report). Every existing row is a report,
    /// so NULL needs no backfill. The thread load reads the column, so it is a
    /// step of its own rather than a line in `migrate_v1`, which a database
    /// already past v1 never runs again. Idempotent, so it is also safe on the
    /// forward-stamp path.
    fn migrate_v7(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(thread_messages)")?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if !columns.is_empty() && !columns.iter().any(|name| name == "mode") {
            conn.execute("ALTER TABLE thread_messages ADD COLUMN mode TEXT", [])?;
        }
        Ok(())
    }

    /// v7 → v8: a browse chat's own provider/model/effort pick
    /// (`BrowseHarness`) beside its resumable session id, the Codex thread a
    /// Codex pick resumes (with its usage total, the next turn's meter
    /// baseline), and which provider wrote each reply. All nullable columns.
    ///
    /// Two branches both claimed v7 before either shipped, one for the thread
    /// mode and one for these columns, so a database stamped 7 by the browse
    /// branch's build lacks `thread_messages.mode`. Re-running the idempotent
    /// v7 step first (the `migrate_v3` pattern) repairs that stamp too.
    /// Idempotent, so it is also safe on the forward-stamp path.
    fn migrate_v8(conn: &Connection) -> rusqlite::Result<()> {
        Self::migrate_v7(conn)?;
        for (table, column) in [
            ("browse_threads", "backend"),
            ("browse_threads", "model"),
            ("browse_threads", "effort"),
            ("browse_threads", "codex_thread_id"),
            ("browse_threads", "codex_usage"),
            ("browse_messages", "backend"),
        ] {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
            // No table at all is a foreign schema; `verify_schema` names it.
            if !columns.is_empty() && !columns.iter().any(|name| name == column) {
                conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"), [])?;
            }
        }
        Ok(())
    }

    /// v8 → v9: `browse_messages.target_browse_id`, the tab a turn was sent
    /// against. A shared chat's thread belongs to no tab, so without it a
    /// message could not say which page it was about: a mission pin of an
    /// older reply was filed under whatever tab was on screen, and
    /// `/v1/browser/thread?tab=` could not find the shared-chat turns about a
    /// tab. NULL on every earlier row, which then reads as "the page the
    /// conversation targets now", as before. Idempotent, so it is also safe
    /// on the forward-stamp path.
    fn migrate_v9(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(browse_messages)")?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
        // No table at all is a foreign schema; `verify_schema` names it.
        if columns.is_empty() {
            return Ok(());
        }
        if !columns.iter().any(|name| name == "target_browse_id") {
            conn.execute("ALTER TABLE browse_messages ADD COLUMN target_browse_id TEXT", [])?;
        }
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_browse_messages_target
                 ON browse_messages (target_browse_id, created_at)",
            [],
        )?;
        Ok(())
    }

    /// Session organization is additive; schema shape wins over a colliding
    /// version stamp. Safe after a partially completed migration as well.
    fn migrate_v10(conn: &Connection) -> rusqlite::Result<()> {
        for (table, additions) in [
            ("sessions", vec![("archived_at", "INTEGER"), ("title_override", "TEXT")]),
            ("companion_sessions", vec![("archived_at", "INTEGER")]),
        ] {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = stmt.query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if columns.is_empty() { continue; }
            for (name, kind) in additions {
                if !columns.iter().any(|c| c == name) {
                    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {name} {kind}"), [])?;
                }
            }
        }
        Ok(())
    }

    pub fn session_organization(&self) -> rusqlite::Result<std::collections::HashMap<String, (Option<i64>, Option<String>)>> {
        let conn = self.read_conn();
        let mut stmt = conn.prepare("SELECT session_id, archived_at, title_override FROM sessions")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        rows.collect()
    }

    pub fn archive_session(&self, id: &str, archived: bool) -> rusqlite::Result<bool> {
        Ok(self.lock_conn().execute(
            "UPDATE sessions SET archived_at=?2 WHERE session_id=?1 AND (?2 IS NULL OR attach_state != 'held')",
            params![id, archived.then(crate::state::now_millis)],
        )? > 0)
    }

    pub fn rename_session(&self, id: &str, title: Option<&str>) -> rusqlite::Result<bool> {
        Ok(self.lock_conn().execute("UPDATE sessions SET title_override=?2 WHERE session_id=?1", params![id, title])? > 0)
    }

    pub fn archive_companion(&self, id: &str, archived: bool) -> rusqlite::Result<bool> {
        Ok(self.lock_conn().execute("UPDATE companion_sessions SET archived_at=?2 WHERE companion_id=?1", params![id, archived.then(crate::state::now_millis)])? > 0)
    }

    /// v2 → v3: repair the stamp collision with the older cockpit lineage.
    /// Its version 2 had neither sessions.effort nor the native run tables.
    /// Reusing the additive, idempotent step preserves all existing history
    /// and is also safe for databases that already received our version 2.
    fn migrate_v3(conn: &Connection) -> rusqlite::Result<()> {
        Self::migrate_v2(conn)?;
        // Verify before the caller writes version 3, including on a partial
        // legacy schema whose unrelated required columns are still missing.
        // Against the v3 shape: what v5 adds does not exist yet.
        Self::verify_schema_at(conn, 3)
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
            -- a tab's context reuse that tab's own browse thread. Retired: nothing
            -- writes these tables now, and their rows stay for the record.
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
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN fork_model TEXT", []);
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN fork_effort TEXT", []);
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute("UPDATE sessions SET archived_at=NULL WHERE session_id=?1", [session_id])?;
        tx.execute(
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
        Self::touch_session(&tx, session_id, revision.received_at);
        tx.commit()?;
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    /// Move a plan and its session-origin work together. Prompt provenance is
    /// historical and deliberately retains the directory recorded at capture.
    pub fn set_session_project(&self, session_id: &str, path: &str, name: &str, at: i64) -> rusqlite::Result<()> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        tx.execute("UPDATE sessions SET project_path=?2, project_name=?3, updated_at=?4 WHERE session_id=?1", params![session_id, path, name, at])?;
        tx.execute("UPDATE work_items SET project_path=?2 WHERE origin_kind='session' AND origin_id=?1", params![session_id, path])?;
        tx.commit()
    }

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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO context_journal (ts, kind, surface_kind, surface_id, label, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![now, kind, surface_kind, surface_id, label, detail],
        )?;
        let id = tx.last_insert_rowid();
        let _ = tx.execute(
            "DELETE FROM context_journal
             WHERE id <= ?1 - ?2 OR ts < ?3 - ?4",
            params![id, JOURNAL_KEEP_ROWS, now, JOURNAL_KEEP_MS],
        );
        tx.commit()?;
        Ok(id)
    }

    /// Journal rows strictly after `since_id`, oldest-first, capped at `limit` —
    /// the Companion's "while you were away" delta.
    pub fn list_journal_since(
        &self,
        since_id: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<JournalRow>> {
        let conn = self.read_conn();
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

    /// Write a scaled build's durable state (config, limits, phase).
    pub fn upsert_scaled_run(&self, ctl: &crate::scaled::RunCtl) -> rusqlite::Result<()> {
        let now = crate::state::now_millis();
        let json = |v: serde_json::Result<String>| v.unwrap_or_else(|_| "null".into());
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO scaled_runs (run_id, plan_session_id, config_json, limits_json, phase_json, started_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(run_id) DO UPDATE SET config_json = ?3, limits_json = ?4, phase_json = ?5, started_at = ?6, updated_at = ?7",
            params![
                ctl.run_id,
                ctl.plan_session_id,
                json(serde_json::to_string(&ctl.config)),
                json(serde_json::to_string(&ctl.limits)),
                json(serde_json::to_string(&ctl.phase)),
                ctl.started_at,
                now
            ],
        )?;
        Ok(())
    }

    /// A scaled build rebuilt from its row. A pre-flight that was waiting
    /// when the app went down cannot still be held, so it reads as Launching
    /// (the lead's next Workflow call brings a fresh one).
    pub fn get_scaled_run(&self, run_id: &str) -> rusqlite::Result<Option<crate::scaled::RunCtl>> {
        let conn = self.read_conn();
        let row = conn
            .query_row(
                "SELECT plan_session_id, config_json, limits_json, phase_json, started_at FROM scaled_runs WHERE run_id = ?1",
                params![run_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<i64>>(4)?)),
            )
            .optional()?;
        let Some((plan, config, limits, phase, started_at)) = row else { return Ok(None) };
        let Ok(config) = serde_json::from_str(&config) else { return Ok(None) };
        let mut ctl = crate::scaled::RunCtl::new(run_id, &plan, config);
        if let Ok(limits) = serde_json::from_str(&limits) {
            ctl.limits = limits;
        }
        ctl.phase = match serde_json::from_str(&phase) {
            Ok(crate::scaled::Phase::Preflight) | Err(_) => crate::scaled::Phase::Launching,
            Ok(phase) => phase,
        };
        ctl.started_at = started_at;
        Ok(Some(ctl))
    }

    /// The newest journal rows of one kind, newest first. The chat room's
    /// workspace brief reads its "recently browsed" list from the `nav` rows.
    pub fn list_recent_journal_kind(&self, kind: &str, limit: i64) -> rusqlite::Result<Vec<JournalRow>> {
        let conn = self.read_conn();
        let mut stmt = conn.prepare(
            "SELECT id, ts, kind, surface_kind, surface_id, label, detail
             FROM context_journal WHERE kind = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![kind, limit.max(1)], |r| {
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

    /// The newest decision events (`DECISION_KINDS`), newest first, as
    /// `(seq, kind, session_id, comment body)`. The comment body is joined only
    /// when the event references one. Deliberately lighter than
    /// `decision_event_context`, which reads each session's whole plan.
    pub fn recent_decisions(&self, limit: i64) -> rusqlite::Result<Vec<DecisionRow>> {
        let conn = self.read_conn();
        let mut stmt = conn.prepare(
            // A subquery, not a join: a comment id repeats across the
            // revisions it was carried into, and a join would repeat the event.
            "SELECT e.seq, e.kind, e.session_id,
                    (SELECT c.body FROM comments c
                     WHERE e.ref_kind = 'comment' AND c.id = e.ref_id LIMIT 1)
             FROM ledger_events e
             WHERE e.kind IN ('resolution', 'approval', 'review_verdict')
             ORDER BY e.seq DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.max(1)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect()
    }

    /// The newest journal row id (0 when empty) — the seq a reader can resume
    /// its delta from.
    pub fn journal_head(&self) -> rusqlite::Result<i64> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
        let mut stmt = conn.prepare(
            "SELECT companion_id, title, status, created_at, updated_at, model, effort,
                    title_is_user_set, archived_at, project_path
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
                archived_at: r.get(8)?,
                project_path: r.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn companion_project(&self, id: &str) -> Option<String> {
        self.read_conn().query_row("SELECT project_path FROM companion_sessions WHERE companion_id=?1", [id], |r| r.get(0)).optional().ok().flatten().flatten()
    }

    pub fn set_companion_project(&self, id: &str, path: Option<&str>) -> rusqlite::Result<bool> {
        Ok(self.lock_conn().execute("UPDATE companion_sessions SET project_path=?2 WHERE companion_id=?1", params![id, path])? > 0)
    }

    pub fn set_companion_meta(&self, id: &str, meta: &str) -> rusqlite::Result<()> {
        self.lock_conn().execute("UPDATE companion_messages SET meta=?2 WHERE id=?1", params![id, meta])?;
        Ok(())
    }

    pub fn companion_meta(&self, id: &str) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.read_conn();
        let mut stmt = conn.prepare("SELECT id,meta FROM companion_messages WHERE companion_id=?1 AND meta IS NOT NULL ORDER BY created_at,id")?;
        let rows = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
        rows
    }

    pub fn advance_companion_message(&self, id: &str) -> rusqlite::Result<()> {
        self.lock_conn().execute("UPDATE companion_messages SET status='complete',created_at=MAX(?2,1+(SELECT COALESCE(MAX(created_at),0) FROM companion_messages WHERE companion_id=(SELECT companion_id FROM companion_messages WHERE id=?1))) WHERE id=?1", params![id, crate::state::now_millis()])?;
        Ok(())
    }

    /// One chat's per-conversation seat override, as `(model, effort)`. Both
    /// `None` means "use the `companion` seat's own flags" — the override is
    /// additive, never a second source of truth for the seat.
    pub fn get_companion_seat(&self, companion_id: &str) -> (Option<String>, Option<String>) {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM companion_messages WHERE companion_id = ?1",
            params![companion_id],
        )?;
        tx.execute(
            "DELETE FROM companion_sessions WHERE companion_id = ?1",
            params![companion_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_companion_session(&self, companion_id: &str) -> Option<String> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    /// A first Plan/Run action still belongs to its chat. The supplied nonce
    /// makes a retry reuse the source row without sending an agent turn.
    pub fn persist_companion_steer_segment(
        &self,
        segment: &crate::state::CompanionMessage,
        user_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction()?;
        if !segment.body.is_empty() {
            tx.execute("INSERT INTO companion_messages(id,companion_id,role,body,status,surface_kind,surface_id,surface_label,created_at) VALUES(?1,?2,'assistant',?3,'complete',?4,?5,?6,MAX(?7,1+(SELECT COALESCE(MAX(created_at),0) FROM companion_messages WHERE companion_id=?2)))",params![segment.id,segment.companion_id,segment.body,segment.surface_kind,segment.surface_id,segment.surface_label,segment.created_at])?;
        }
        if tx.execute("UPDATE companion_messages SET status='complete',created_at=1+(SELECT COALESCE(MAX(created_at),0) FROM companion_messages WHERE companion_id=?2) WHERE id=?1 AND companion_id=?2",params![user_id,segment.companion_id])?!=1{return Err(rusqlite::Error::QueryReturnedNoRows);}
        tx.commit()
    }

    pub fn seed_companion_handoff(
        &self,
        companion_id: &str,
        message_id: &str,
        body: &str,
        project_path: Option<&str>,
        at: i64,
    ) -> rusqlite::Result<Option<crate::state::CompanionMessage>> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute("INSERT INTO companion_messages(id,companion_id,role,body,status,surface_kind,created_at) SELECT ?1,?2,'user',?3,'complete','chat',MAX(?4,1+(SELECT COALESCE(MAX(created_at),0) FROM companion_messages WHERE companion_id=?2)) WHERE EXISTS(SELECT 1 FROM companion_sessions WHERE companion_id=?2) ON CONFLICT(id) DO NOTHING",params![message_id,companion_id,body,at])?;
        let row=tx.query_row("SELECT id,companion_id,role,body,status,surface_kind,surface_id,surface_label,created_at FROM companion_messages WHERE id=?1 AND companion_id=?2 AND body=?3 AND role='user' AND status='complete'",params![message_id,companion_id,body],|r|Ok(crate::state::CompanionMessage{id:r.get(0)?,companion_id:r.get(1)?,role:r.get(2)?,body:r.get(3)?,status:r.get(4)?,surface_kind:r.get(5)?,surface_id:r.get(6)?,surface_label:r.get(7)?,created_at:r.get(8)?})).optional()?;
        if row.is_some() {
            tx.execute("UPDATE companion_sessions SET project_path=COALESCE(project_path,?2),updated_at=MAX(updated_at,?3) WHERE companion_id=?1",params![companion_id,project_path,at])?;
        }
        tx.commit()?;
        Ok(row)
    }
    pub fn insert_companion_message(
        &self,
        msg: &crate::state::CompanionMessage,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO companion_messages
                (id, companion_id, role, body, status, surface_kind, surface_id,
                 surface_label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, MAX(?9, 1 + (SELECT COALESCE(MAX(created_at),0) FROM companion_messages WHERE companion_id=?2)))",
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
        Self::touch_companion_locked(&tx, &msg.companion_id, msg.created_at);
        tx.commit()?;
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        Self::delete_draft_locked(&tx, draft_id)?;
        tx.commit()
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        let edges = Self::folder_edges_locked(&tx)?;
        let subtree = folder_subtree(&edges, folder_id);
        let mut deleted: Vec<String> = Vec::new();
        for fid in &subtree {
            let mut stmt = tx.prepare("SELECT draft_id FROM drafts WHERE folder_id = ?1")?;
            let ids: Vec<String> = stmt
                .query_map(params![fid], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            drop(stmt);
            for id in ids {
                Self::delete_draft_locked(&tx, &id)?;
                deleted.push(id);
            }
            tx.execute(
                "DELETE FROM bookshelf_folders WHERE folder_id = ?1",
                params![fid],
            )?;
        }
        tx.commit()?;
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO friction_events (ts, kind, surface, session_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now, kind, surface, session_id, detail],
        )?;
        let id = tx.last_insert_rowid();
        let _ = tx.execute(
            "DELETE FROM friction_events
             WHERE id <= ?1 - ?2 OR ts < ?3 - ?4",
            params![id, FRICTION_KEEP_ROWS, now, FRICTION_KEEP_MS],
        );
        tx.commit()?;
        Ok(id)
    }

    /// Friction kinds inside `window_ms`, most-frequent first.
    pub fn friction_summary(&self, window_ms: i64) -> rusqlite::Result<Vec<FrictionCount>> {
        let cutoff = crate::ledger::now_millis() - window_ms.max(0);
        let conn = self.read_conn();
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

    /// Test fixture: mark a finding dismissed. No production path dismisses a
    /// finding since `shipwright_detect_shipped` went, but rows written by
    /// earlier builds can carry the flag, so the readers stay pinned.
    #[cfg(test)]
    pub(crate) fn dismiss_shipwright_finding_for_test(&self, id: &str) -> rusqlite::Result<()> {
        self.lock_conn().execute(
            "UPDATE shipwright_findings SET status = 'dismissed', dismissed = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Findings, newest first. `include_dismissed = false` is what the digest
    /// carries as "open"; the dismissed *summaries* go in separately so the
    /// agent is told not to re-word them.
    pub fn list_shipwright_findings(
        &self,
        include_dismissed: bool,
    ) -> rusqlite::Result<Vec<ShipwrightFinding>> {
        let conn = self.read_conn();
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

    /// Accept/dismiss/ship rates per category — the agent's own track record.
    pub fn shipwright_scores(&self) -> rusqlite::Result<Vec<CategoryScore>> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
    #[cfg(test)]
    pub fn load_draft_chat_thread(
        &self,
        draft_id: &str,
    ) -> rusqlite::Result<Vec<crate::state::DraftChatMessage>> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM mem_chat_messages WHERE thread_id = ?1",
            params![thread_id],
        )?;
        tx.execute(
            "DELETE FROM mem_chat_threads WHERE thread_id = ?1",
            params![thread_id],
        )?;
        tx.commit()?;
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM draft_comments WHERE id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1 AND comment_id = ?2",
            params![draft_id, id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The draft comment's resumable discussion-fork session id.
    pub fn get_draft_comment_fork_session(&self, id: &str) -> Option<String> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    /// Every message body, across every conversation's thread table, that
    /// contains `pattern` (a LIKE pattern). For a sweep that must never delete
    /// what a message still names, such as a chat's screenshot.
    pub fn texts_mentioning(&self, pattern: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.read_conn();
        let like = format!("%{pattern}%");
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for kind in ["browse", "linked", "mission", "companion", "voice", "drafter", "memchat", "session"] {
            let Some((table, _, body, _)) = Self::thread_table(kind) else { continue };
            if seen.contains(&table) {
                continue;
            }
            seen.push(table);
            let mut stmt = conn.prepare(&format!("SELECT {body} FROM {table} WHERE {body} LIKE ?1"))?;
            let rows = stmt.query_map(params![like], |row| row.get::<_, String>(0))?;
            out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok(out)
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

    /// Every message row's meter for one thread, as `(id, meter_json)`. The
    /// surfaces load a thread in one call, so the meters come back the same
    /// way rather than one round-trip per bubble.
    pub fn thread_meters(&self, kind: &str, thread_id: &str) -> Vec<(String, String)> {
        let Some((table, key, _, _)) = Self::thread_table(kind) else {
            return Vec::new();
        };
        let conn = self.read_conn();
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

    /// Plan sessions whose transcript is known, newest activity first — the
    /// tailer's work list. Bounded: an old, settled session's transcript stops
    /// growing, so re-walking the whole history buys nothing.
    pub fn plan_transcripts(&self, limit: i64) -> Vec<(String, String)> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    /// The database's file on disk, or `None` for an in-memory database.
    /// Holds the shared lock only for the length of a pointer read.
    pub fn file_path(&self) -> Option<std::path::PathBuf> {
        let conn = self.lock_conn();
        conn.path()
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from)
    }

    /// `VACUUM INTO dest` WITHOUT the shared connection's lock: the copy runs
    /// on a short-lived read-only connection of its own, opened on the same
    /// file. WAL lets that reader see a consistent snapshot while the app's
    /// connection keeps reading and writing — the old path held the ONE
    /// `Mutex<Connection>` for the seconds a full-database vacuum takes, and
    /// every sync command queued behind it on the main thread (the 2026-09-29
    /// memory beach ball). Falls back to the shared connection only when there
    /// is no file (in-memory) or the side connection fails.
    pub fn snapshot_off_lock(&self, dest: &Path) -> rusqlite::Result<()> {
        if let Some(src) = self.file_path() {
            match Self::snapshot_file(&src, dest) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    tracing::warn!(error = %e, "off-lock snapshot failed; retrying on the shared connection");
                    let _ = std::fs::remove_file(dest);
                }
            }
        }
        self.snapshot_to(dest)
    }

    /// The side-connection half of `snapshot_off_lock`.
    pub(crate) fn snapshot_file(src: &Path, dest: &Path) -> rusqlite::Result<()> {
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open_with_flags(
            src,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])?;
        Ok(())
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

    #[cfg(test)]
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
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
        tx.execute(
            "INSERT INTO comments (
                id, session_id, version_number, type, scope, anchor_id,
                body, edit_original, edit_revised, created_at, status,
                resolution_body, resolution_version, resolution_accepted_at,
                block_id, structural_json,
                sel_char_start, sel_char_end, sel_quoted_text,
                sel_sub_block_id, reopen_note, reopen_history, actionable,
                author, agent_state, reviewer,
                external_created_at, share_request_id, attachments, research
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)",
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
                research_to_json(comment.research.as_ref()),
            ],
        )?;
        Self::touch_session(&tx, session_id, comment.created_at);
        tx.commit()?;
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
                attachments = ?23,
                research = ?26
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
                research_to_json(comment.research.as_ref()),
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE sessions SET attach_state = ?1 WHERE session_id = ?2",
            params![state, session_id],
        )?;
        Self::touch_session(&tx, session_id, crate::state::now_millis());
        tx.commit()?;
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        // Cascade the comment's discussion thread. Comment ids are reused
        // (`c-{max+1}`), so leaving these rows would resurface a deleted
        // comment's answer under the next comment that inherits its id.
        tx.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1 AND comment_id = ?2",
            params![session_id, comment_id],
        )?;
        tx.execute(
            "DELETE FROM comments WHERE session_id = ?1 AND id = ?2",
            params![session_id, comment_id],
        )?;
        tx.commit()?;
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
        let tx = conn.unchecked_transaction()?;
        for table in ["comments", "thread_messages"] {
            tx.execute(
                &format!(
                    "UPDATE {table} SET attachments = REPLACE(attachments, ?1, ?2)
                     WHERE session_id = ?3 AND attachments IS NOT NULL"
                ),
                params![from, to, new_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_session(&self, session_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        tx.execute(
            "DELETE FROM comments WHERE session_id = ?1",
            params![session_id],
        )?;
        tx.execute(
            "DELETE FROM revisions WHERE session_id = ?1",
            params![session_id],
        )?;
        // Staged (never-written) offers go with the session that produced them.
        // NOTE: `voice_messages` / `voice_sessions` are *not* cleared here —
        // pre-existing, and out of scope for this change.
        tx.execute(
            "DELETE FROM comment_offers WHERE session_id = ?1",
            params![session_id],
        )?;
        tx.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            params![session_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    // --- Fork-agent discussion threads (Phase 2) ---------------------------
    // `thread_messages` rows are terminal: written only when a turn finishes.
    // `comments.fork_session_id` is a DB-only column (not on the `Comment`
    // struct) so resuming a fork never reads a stale in-memory value.

    pub fn insert_thread_message(&self, msg: &ThreadMessage) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO thread_messages
                (id, session_id, comment_id, role, body, status, created_at,
                 attachments, mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                msg.id,
                msg.session_id,
                msg.comment_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at,
                attachments_to_json(&msg.attachments),
                msg.mode,
            ],
        )?;
        Self::touch_session(&tx, &msg.session_id, msg.created_at);
        tx.commit()?;
        Ok(())
    }

    pub fn load_thread(
        &self,
        session_id: &str,
        comment_id: &str,
    ) -> rusqlite::Result<Vec<ThreadMessage>> {
        let conn = self.read_conn();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, comment_id, role, body, status, created_at,
                    attachments, mode
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
                mode: row.get(8)?,
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
        let conn = self.read_conn();
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

    pub fn get_comment_fork_seat(&self, session_id: &str, comment_id: &str) -> (Option<String>, Option<String>) {
        self.read_conn().query_row("SELECT fork_model, fork_effort FROM comments WHERE session_id = ?1 AND id = ?2", params![session_id, comment_id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap_or_default()
    }

    pub fn set_comment_fork_seat(&self, session_id: &str, comment_id: &str, model: Option<&str>, effort: Option<&str>) -> rusqlite::Result<()> {
        self.lock_conn().execute("UPDATE comments SET fork_model = ?1, fork_effort = ?2 WHERE session_id = ?3 AND id = ?4", params![model, effort, session_id, comment_id])?;
        Ok(())
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
        let conn = self.read_conn();
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
                (id, browse_id, role, body, status, created_at, backend, target_browse_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                msg.id,
                msg.browse_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at,
                msg.backend,
                msg.target_browse_id,
            ],
        )?;
        Ok(())
    }

    pub fn load_browse_thread(&self, browse_id: &str) -> rusqlite::Result<Vec<BrowseMessage>> {
        self.browse_messages_where("browse_id = ?1", browse_id)
    }

    /// What was discussed about a tab: its own thread, and every turn a shared
    /// chat (or a conversation anchored elsewhere) sent against it — the
    /// `/v1/browser/thread?tab=` check-in, which in linked mode would
    /// otherwise read an empty thread (BC-22). Oldest first, interleaved.
    pub fn load_browse_thread_about(&self, browse_id: &str) -> rusqlite::Result<Vec<BrowseMessage>> {
        self.browse_messages_where("browse_id = ?1 OR target_browse_id = ?1", browse_id)
    }

    fn browse_messages_where(&self, filter: &str, browse_id: &str) -> rusqlite::Result<Vec<BrowseMessage>> {
        let conn = self.read_conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT id, browse_id, role, body, status, created_at, backend, target_browse_id
             FROM browse_messages
             WHERE {filter}
             ORDER BY created_at, id"
        ))?;
        let rows = stmt.query_map(params![browse_id], |row| {
            Ok(BrowseMessage {
                id: row.get(0)?,
                browse_id: row.get(1)?,
                role: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
                backend: row.get(6)?,
                target_browse_id: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    /// Delete a tab's whole thread: its turns and its persisted agent session.
    pub fn delete_browse_thread(&self, browse_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM browse_messages WHERE browse_id = ?1",
            params![browse_id],
        )?;
        tx.execute(
            "DELETE FROM browse_threads WHERE browse_id = ?1",
            params![browse_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_browse_session(&self, browse_id: &str) -> Option<String> {
        let conn = self.read_conn();
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
    /// of re-sending the over-limit context forever. The visible thread is kept,
    /// and so is the chat's model pick: only the id is nulled, never the row.
    pub fn clear_browse_session(&self, browse_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE browse_threads SET claude_session_id = NULL WHERE browse_id = ?1",
            params![browse_id],
        )?;
        Ok(())
    }

    /// The Codex thread a Codex pick resumes. Its own column, never
    /// `claude_session_id`: neither CLI rejects the other's id, so each
    /// provider keeps (and resumes) only its own — the `comments.fork_backend`
    /// rule, per page chat.
    pub fn get_browse_codex_thread(&self, browse_id: &str) -> Option<String> {
        self.read_conn()
            .query_row(
                "SELECT codex_thread_id FROM browse_threads WHERE browse_id = ?1",
                params![browse_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
    }

    /// The Codex thread's running usage total (JSON) as of its last turn. The
    /// app-server reports thread totals, so this is the next turn's baseline.
    pub fn get_browse_codex_usage(&self, browse_id: &str) -> Option<String> {
        self.read_conn()
            .query_row(
                "SELECT codex_usage FROM browse_threads WHERE browse_id = ?1",
                params![browse_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
    }

    /// Store the Codex thread and its usage total. Upserts, and never touches
    /// the Claude session or the pick.
    pub fn set_browse_codex_thread(
        &self,
        browse_id: &str,
        thread_id: &str,
        usage: &str,
    ) -> rusqlite::Result<()> {
        self.lock_conn().execute(
            "INSERT INTO browse_threads (browse_id, codex_thread_id, codex_usage)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(browse_id) DO UPDATE SET codex_thread_id = ?2, codex_usage = ?3",
            params![browse_id, thread_id, usage],
        )?;
        Ok(())
    }

    /// Move the stored Codex thread's usage total, and nothing else: a turn
    /// that resumed it but never answered still advanced the thread's totals.
    /// A no-op once that thread is no longer the stored one (reset, or the
    /// whole row dropped by "Clear history").
    pub fn set_browse_codex_usage(
        &self,
        browse_id: &str,
        thread_id: &str,
        usage: &str,
    ) -> rusqlite::Result<()> {
        self.lock_conn().execute(
            "UPDATE browse_threads SET codex_usage = ?3 WHERE browse_id = ?1 AND codex_thread_id = ?2",
            params![browse_id, thread_id, usage],
        )?;
        Ok(())
    }

    /// Forget the Codex thread (and its baseline) — `clear_browse_session`'s
    /// Codex counterpart. The Claude session, the pick and the visible thread
    /// all stay.
    pub fn clear_browse_codex_thread(&self, browse_id: &str) -> rusqlite::Result<()> {
        self.lock_conn().execute(
            "UPDATE browse_threads SET codex_thread_id = NULL, codex_usage = NULL WHERE browse_id = ?1",
            params![browse_id],
        )?;
        Ok(())
    }

    /// This chat's own provider/model/effort pick; all `None` when it has never
    /// had one (or has no row yet).
    pub fn get_browse_harness(&self, browse_id: &str) -> BrowseHarness {
        self.read_conn()
            .query_row(
                "SELECT backend, model, effort FROM browse_threads WHERE browse_id = ?1",
                params![browse_id],
                |row| {
                    Ok(BrowseHarness {
                        backend: row.get(0)?,
                        model: row.get(1)?,
                        effort: row.get(2)?,
                    })
                },
            )
            .unwrap_or_default()
    }

    /// Store this chat's pick. Upserts, and never touches either resumable id:
    /// a model change resumes the same session on the next turn.
    pub fn set_browse_harness(
        &self,
        browse_id: &str,
        harness: &BrowseHarness,
    ) -> rusqlite::Result<()> {
        self.lock_conn().execute(
            "INSERT INTO browse_threads (browse_id, backend, model, effort)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(browse_id) DO UPDATE SET backend = ?2, model = ?3, effort = ?4",
            params![browse_id, harness.backend, harness.model, harness.effort],
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
        let max: Option<i64> = conn.query_row(
            "SELECT MAX(sort_idx) FROM browse_list_items WHERE browse_id = ?1",
            params![browse_id],
            |row| row.get(0),
        )?;
        Ok(max.unwrap_or(-1) + 1)
    }

    pub fn get_browse_list_item(&self, id: &str) -> rusqlite::Result<Option<BrowseListItem>> {
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM browse_list_items WHERE browse_id = ?1",
            params![browse_id],
        )?;
        tx.execute(
            "DELETE FROM browse_lists WHERE browse_id = ?1",
            params![browse_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    // --- Missions ----------------------------------------------------------
    // The research-mission orchestrator: one shared goal across the browser
    // pane, with curated pins (`mission_findings`) and a resumable chat
    // (`mission_messages` + the `claude_session_id` on the row). Mirrors the
    // browse helpers above but keyed by `mission_id`. See mission.rs.

    #[cfg(test)]
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM mission_findings WHERE mission_id = ?1",
            params![mission_id],
        )?;
        tx.execute(
            "DELETE FROM mission_messages WHERE mission_id = ?1",
            params![mission_id],
        )?;
        tx.execute("DELETE FROM missions WHERE mission_id = ?1", params![mission_id])?;
        tx.commit()?;
        Ok(())
    }

    // --- Mission findings (pins) -------------------------------------------

    #[cfg(test)]
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
        let conn = self.read_conn();
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

    /// Net thumbs score per domain across ALL tabs (sum of +1/-1), most-liked
    /// first. Feeds the friction digest's source-trust signal (`context.rs`).
    /// Tandem mode and its thumbs strip are retired, so these are the
    /// verdicts recorded before then; nothing writes new ones.
    pub fn domain_feedback_summary(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    /// Distinct working directories the user has worked in, most-recent first —
    /// every `sessions.project_path` (a plan review). This is Redline's de-facto
    /// "projects" registry: it backs the browse agent's `/v1/code/projects` map
    /// and is the allowlist the read-only git route validates a `repo` against.
    /// Paths are returned verbatim (may no longer exist on disk — the caller
    /// filters).
    pub fn list_project_paths(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.read_conn();
        let mut stmt = conn.prepare(
            "SELECT path FROM (
                 SELECT project_path AS path, MAX(created_at) AS seen FROM sessions
                 WHERE project_path IS NOT NULL AND project_path <> '' GROUP BY project_path
                 UNION ALL SELECT path, created_at AS seen FROM git_workspaces WHERE state = 'active'
             ) GROUP BY path ORDER BY MAX(seen) DESC",
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
        conn.query_row(
            "SELECT first_seen_at FROM dev_servers WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    // --- Offered plan items (staged, not written) ---------------------------
    // See `CommentOffer`. Rows here are proposals: nothing reaches the plan
    // until `claim_comment_offer` wins and `add_feedback_from_offer` writes the
    // comment.

    /// `stale` and `explicit` are not columns — staleness is computed against
    /// the current plan by `comment_offers_pending`, and `explicit` only rides
    /// the live event — so every row reads back as fresh and tap-to-add.
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
            explicit: false,
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    /// Durable history totals for diagnostics; query failure is never an
    /// empty-history result. One lock and one read cover all three tables.
    pub fn plan_history_counts(&self) -> rusqlite::Result<(i64, i64, i64)> {
        self.read_conn().query_row(
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
        let conn = self.read_conn();
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
                    external_created_at, share_request_id, attachments, research
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
            let research = row
                .get::<_, Option<String>>(29)?
                .and_then(|j| serde_json::from_str::<ResearchLink>(&j).ok());
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
                    research,
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
        let conn = self.read_conn();
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
    #[cfg(test)]
    pub fn list_work_items(
        &self,
        status: Option<&str>,
        project: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::work::WorkItem>> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
        let mut stmt = conn.prepare(&format!(
            "{READY_WORK_CTE}
             SELECT {} FROM work_items w
             WHERE {READY_WORK_WHERE}
             ORDER BY w.pinned DESC, w.priority ASC, w.created_at ASC
             LIMIT ?3",
            Self::WORK_ITEM_COLS
        ))?;
        let rows = stmt.query_map(params![project, now, limit.max(1)], |r| {
            Self::row_to_work_item(r)
        })?;
        rows.collect()
    }

    /// The size of the ready frontier `list_ready_work_items` pages — the SAME
    /// CTE and predicate (shared consts, so the two can't drift), as one
    /// `COUNT(*)`. The memory pill's "· N ready" segment reads this instead of
    /// pulling the whole work graph (~1.5 MB of JSON) every 60s just to take
    /// `readyIds.length`.
    pub fn count_ready_work_items(&self, project: Option<&str>, now: i64) -> rusqlite::Result<i64> {
        let conn = self.read_conn();
        conn.query_row(
            &format!("{READY_WORK_CTE} SELECT COUNT(*) FROM work_items w WHERE {READY_WORK_WHERE}"),
            params![project, now],
            |r| r.get(0),
        )
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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

    #[cfg(test)]
    pub fn get_seat_stat(&self, seat: &str) -> Option<SeatStatRow> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
    #[cfg(test)]
    pub fn seat_burn_totals_by_day(&self, limit: i64) -> rusqlite::Result<Vec<SeatBurnRow>> {
        let conn = self.read_conn();
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
        let conn = self.read_conn();
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
#[path = "db_batched_read_tests.rs"]
mod batched_read_tests;

/// The prompt lake's FTS index. `prompts` is not insert-only — compaction and
/// explicit forget rewrite rows in place — so these cover the trigger set that
/// `browse_events_fts` never needed.
#[cfg(test)]
#[path = "db_prompt_fts_tests.rs"]
mod prompt_fts_tests;

/// Query-plan guards for the retrieval hot path. A perf regression here is
/// invisible in behavior — every one of these queries returns the same rows
/// whether it uses an index or scans the table — so the assertion is on the
/// PLAN, not the result. If one of these starts failing, an index was dropped
/// or a WHERE clause was rewritten past the index it was shaped for.
///
/// The rule: a hot read may not `SCAN` a table that grows with the record
/// (`ledger_events`, `prompts`, `class_links`, `user_notes`).
#[cfg(test)]
#[path = "db_query_plan_guards.rs"]
mod query_plan_guards;

/// The work-graph deep-logic battery: ready-CTE semantics, the claim race,
/// lease expiry, ledger-chain integrity, origin-outliving, and the state-plane
/// boundary guard. Lives beside the SQL it verifies (the work-graph region of
/// `impl Database` above).
#[cfg(test)]
#[path = "db_work_graph_tests.rs"]
mod work_graph_tests;

#[cfg(test)]
#[path = "db_tests.rs"]
mod tests;

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
        Self::runner_read(&self.read_conn(), run_id)
    }
    pub fn runner_list(&self) -> Result<Vec<crate::runner_graph::RunGraph>, String> {
        let conn = self.read_conn();
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
    // --- candidate releases (Build Redline) --------------------------------

    /// Insert or replace a release row. The status transition is checked by
    /// the caller (`self_develop`), which owns the lifecycle; this is storage.
    pub fn release_put(&self, release: &crate::self_develop::Release) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO releases(release_id,run_id,repository,status,candidate_root,bundle_path,\
             manifest_json,capture_json,probe_json,failure,step,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) \
             ON CONFLICT(release_id) DO UPDATE SET \
             run_id=excluded.run_id, status=excluded.status, bundle_path=excluded.bundle_path, \
             manifest_json=excluded.manifest_json, capture_json=excluded.capture_json, \
             probe_json=excluded.probe_json, failure=excluded.failure, step=excluded.step, \
             updated_at=excluded.updated_at",
            params![
                release.release_id,
                release.run_id,
                release.repository,
                release.status,
                release.candidate_root,
                release.bundle_path,
                release.manifest.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default()),
                release.capture.as_ref().map(|c| serde_json::to_string(c).unwrap_or_default()),
                release.probe.as_ref().map(|p| serde_json::to_string(p).unwrap_or_default()),
                release.failure,
                release.step,
                release.created_at,
                release.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn release_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::self_develop::Release> {
        let manifest: Option<String> = row.get(6)?;
        let capture: Option<String> = row.get(7)?;
        let probe: Option<String> = row.get(8)?;
        Ok(crate::self_develop::Release {
            release_id: row.get(0)?,
            run_id: row.get(1)?,
            repository: row.get(2)?,
            status: row.get(3)?,
            candidate_root: row.get(4)?,
            bundle_path: row.get(5)?,
            manifest: manifest.and_then(|s| serde_json::from_str(&s).ok()),
            capture: capture.and_then(|s| serde_json::from_str(&s).ok()),
            probe: probe.and_then(|s| serde_json::from_str(&s).ok()),
            failure: row.get(9)?,
            step: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }

    const RELEASE_COLUMNS: &'static str = "release_id,run_id,repository,status,candidate_root,\
         bundle_path,manifest_json,capture_json,probe_json,failure,step,created_at,updated_at";

    pub fn release_get(&self, release_id: &str) -> Result<Option<crate::self_develop::Release>, String> {
        let conn = self.read_conn();
        let sql = format!("SELECT {} FROM releases WHERE release_id=?1", Self::RELEASE_COLUMNS);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query_map([release_id], Self::release_row).map_err(|e| e.to_string())?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn release_list(&self, limit: usize) -> Result<Vec<crate::self_develop::Release>, String> {
        let conn = self.read_conn();
        let sql = format!(
            "SELECT {} FROM releases ORDER BY updated_at DESC LIMIT ?1",
            Self::RELEASE_COLUMNS
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([limit as i64], Self::release_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    }

    /// The release currently holding the activation, if any.
    ///
    /// One at a time is an invariant, not a convention: two exchanges racing
    /// for `/Applications/Redline.app` is how one release silently loses the
    /// other's features.
    pub fn release_holding_activation(&self) -> Result<Option<crate::self_develop::Release>, String> {
        Ok(self
            .release_list(200)?
            .into_iter()
            .find(|r| r.status().holds_activation()))
    }

    pub fn runner_claims(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::runner_graph::RunClaim>, String> {
        Self::runner_claim_rows(&self.read_conn(), run_id)
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
            let conn = self.read_conn();
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
#[path = "db_runner_tests.rs"]
mod runner_tests;

#[cfg(test)]
#[path = "db_runner_persistence_tests.rs"]
mod runner_persistence_tests;

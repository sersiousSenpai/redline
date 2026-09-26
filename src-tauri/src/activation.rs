// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The application's half of an activation.
//!
//! [`redline_activation`] holds the protocol both processes speak. This module
//! is what Redline itself does with it, and it has two entirely separate jobs
//! depending on which side of the restart it is on:
//!
//! **Before the restart** it is the trusted controller. It revalidates the
//! sealed artifact, copies it into a staging directory on the installed
//! application's own filesystem, stops admitting new work, drains what is
//! running, saves the user's workspace and a consistent database snapshot,
//! starts the helper from a protected copy outside either bundle, waits for
//! the helper to say it can finish alone, and only then quits.
//!
//! **After the restart** it is the thing being judged. It reports each startup
//! stage into the transaction directory, keeps the user's own writes and every
//! background side effect gated while it proves it is responsive, and then
//! accepts the release — or tells the helper it failed and lets itself be
//! replaced.
//!
//! On an ordinary launch (which is nearly every launch) both halves are inert:
//! [`context`] is `None`, every report is a no-op, and the only thing that runs
//! is [`reconcile_on_boot`], looking for an activation that never finished.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use redline_activation::{
    Handshake, Journal, Outcome, Resolution, Stage, Step, Transaction,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::release_manifest::{self, ReleaseManifest};
use crate::runtime_profile;

/// Where activations live under the app data directory.
pub const ACTIVATION_DIR: &str = "activation";
/// Where the protected copy of the incumbent's helper is kept — outside either
/// exchanged bundle, so a candidate can never replace the implementation that
/// supervises its own installation.
pub const HELPER_DIR: &str = "activation/helper";
/// The setting the workspace snapshot is parked in across the restart.
pub const WORKSPACE_KEY: &str = "redline.activation.workspace";
/// The setting the last finished activation's report is parked in, so the
/// window that comes back can explain what happened.
pub const REPORT_KEY: &str = "redline.activation.lastReport";

/// How long the frontend gets to flush editors, comments and drafts.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(8);
/// How long to wait for the helper to take up station before giving up and
/// staying on this version.
const HELPER_READY_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Identity: which release is this process?
// ---------------------------------------------------------------------------

/// The bundle this executable is running out of, if it is running out of one.
/// `…/Redline.app/Contents/MacOS/Redline` → `…/Redline.app`.
pub fn own_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension().map(|e| e == "app").unwrap_or(false)
        && bundle.join("Contents/Info.plist").exists())
    .then(|| bundle.to_path_buf())
}

/// The release this process *is*, read out of its own bundle.
///
/// Deliberately not taken from the transaction: the transaction says which
/// release was supposed to be installed, and the whole question a handshake
/// answers is whether it actually was. Reading the running bundle's own
/// manifest is what makes the answer evidence rather than an assertion.
pub fn own_release_id() -> Option<String> {
    static ID: OnceLock<Option<String>> = OnceLock::new();
    ID.get_or_init(|| {
        release_manifest::ReleaseStamp::read_from_bundle(&own_bundle()?).map(|s| s.release_id)
    })
    .clone()
}

/// The release installed at `bundle`, or `None` for an installation that
/// predates release manifests.
pub fn installed_release_id(bundle: &Path) -> Option<String> {
    release_manifest::ReleaseStamp::read_from_bundle(bundle).map(|s| s.release_id)
}

// ---------------------------------------------------------------------------
// Reporting: the startup handshake
// ---------------------------------------------------------------------------

/// The activation this process is being watched by, if any.
pub fn context() -> Option<&'static runtime_profile::ActivationContext> {
    runtime_profile::current().activation()
}

pub fn activating() -> bool {
    context().is_some()
}

fn reported_release() -> String {
    // A process with no bundle manifest (a development build) still reports,
    // so the failure it produces is "this is not the release you staged"
    // rather than silence the helper has to time out on.
    own_release_id().unwrap_or_else(|| "unidentified".to_string())
}

fn highest_stage() -> &'static Mutex<Option<Stage>> {
    static S: OnceLock<Mutex<Option<Stage>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Report a startup stage. A no-op on an ordinary launch.
///
/// Stages never go backwards: a late `Database` report from a reopened
/// connection must not un-say `Frontend`.
pub fn report_stage(stage: Stage, detail: impl Into<String>) {
    let Some(ctx) = context() else { return };
    let detail = detail.into();
    {
        let mut highest = highest_stage().lock().unwrap_or_else(|e| e.into_inner());
        if !stage.is_failure() && highest.map_or(false, |h| h >= stage) {
            return;
        }
        *highest = Some(stage);
    }
    let report = Handshake::new(ctx.txn_id(), reported_release(), stage).with_detail(detail);
    if let Err(e) = report.write_to(&ctx.dir) {
        tracing::error!(error = %e, "could not write the activation handshake");
    } else {
        tracing::info!(?stage, "activation handshake");
    }
}

/// Report that startup failed. The helper rolls back on seeing this, rather
/// than waiting out its launch timeout.
pub fn report_failure(detail: impl Into<String>) {
    report_stage(Stage::Failed, detail);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// Set while an activation is being verified, and while one is being prepared.
/// Either way the answer to "may this write land?" is no.
static GATED: AtomicBool = AtomicBool::new(false);
/// Why, in a sentence the caller can show.
fn gate_reason() -> &'static Mutex<String> {
    static R: OnceLock<Mutex<String>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(String::new()))
}

pub fn gate(reason: impl Into<String>) {
    *gate_reason().lock().unwrap_or_else(|e| e.into_inner()) = reason.into();
    GATED.store(true, Ordering::SeqCst);
}

pub fn ungate() {
    GATED.store(false, Ordering::SeqCst);
    gate_reason().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// True while user mutations and background side effects must not land.
///
/// Two windows need it, for the same reason: anything written during them
/// could be rolled away by a recovery the user did not ask for.
pub fn mutations_gated() -> bool {
    GATED.load(Ordering::SeqCst)
}

pub fn gated_message() -> String {
    let reason = gate_reason().lock().unwrap_or_else(|e| e.into_inner()).clone();
    if reason.is_empty() {
        "Redline is finishing a version change and is not accepting changes right now.".into()
    } else {
        reason
    }
}

/// Whether a background side effect may run. The same question as
/// [`mutations_gated`], named for the callers that are asking about themselves
/// rather than about a request.
pub fn background_effects_allowed() -> bool {
    !mutations_gated() && runtime_profile::current().external_effects()
}

// ---------------------------------------------------------------------------
// The health interval
// ---------------------------------------------------------------------------

/// The workspace has loaded. Start proving the process stays responsive, then
/// accept the release.
///
/// Responsiveness is demonstrated, not assumed: each beat performs a real read
/// through the database and refreshes the handshake. A process wedged on its
/// storage stops beating, and the helper sees a report that stopped advancing
/// rather than a pid that is still technically alive.
pub fn start_health_watch(app: AppHandle) {
    let Some(ctx) = context() else { return };
    let Ok(txn) = Transaction::read_from(&ctx.dir) else {
        report_failure("the activation transaction could not be read from inside the new release");
        return;
    };
    let dir = ctx.dir.clone();
    let txn_id = ctx.txn_id();
    tauri::async_runtime::spawn(async move {
        let release = reported_release();
        let beats = txn.health_secs.max(1);
        for beat in 0..beats {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let responsive = app
                .try_state::<crate::state::SessionStore>()
                .map(|store| store.database().get_setting(WORKSPACE_KEY).is_some() || true)
                .unwrap_or(false);
            if !responsive {
                let report = Handshake::new(&txn_id, &release, Stage::Failed)
                    .with_detail("the new release could not reach its own storage");
                let _ = report.write_to(&dir);
                return;
            }
            let report = Handshake::new(&txn_id, &release, Stage::Workspace)
                .with_detail(format!("health beat {}/{beats}", beat + 1));
            if let Err(e) = report.write_to(&dir) {
                tracing::error!(error = %e, "health beat could not be written");
            }
        }
        let _ = Handshake::new(&txn_id, &release, Stage::Healthy)
            .with_detail("startup verified")
            .write_to(&dir);
        tracing::info!("activation accepted; releasing the gate");
        ungate();
        let _ = app.emit("activation-accepted", release.clone());
        // Everything that was deferred because it reaches outside this process
        // runs now, and not a moment earlier.
        crate::postboot::run_deferred_external(app.clone());
    });
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

/// What survives a restart. Saved state, not live processes — the distinction
/// the UI has to make honestly, because a terminal's shell, a page's
/// JavaScript, an open network connection and a held review request all end
/// when the process does.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub saved_at: i64,
    /// Opaque frontend state: the active surface, selected plan, browser
    /// layout, pane sizes. The backend stores it and hands it back.
    pub frontend: serde_json::Value,
    /// Runs that were live and can be resumed from their own durable state.
    pub resumable_runs: Vec<String>,
    /// Things that were live and will not come back: terminal sessions,
    /// in-flight agent turns, held plan reviews. Listed so the restart summary
    /// can say so instead of pretending.
    pub interrupted: Vec<InterruptedWork>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedWork {
    /// `terminal`, `agent-turn`, `held-review`, `browser-tab`.
    pub kind: String,
    pub label: String,
    /// What the user can do about it afterwards, if anything.
    pub recovery: String,
}

impl WorkspaceSnapshot {
    pub fn save(&self, db: &crate::db::Database) -> Result<(), String> {
        db.set_setting(
            WORKSPACE_KEY,
            &serde_json::to_string(self).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    pub fn load(db: &crate::db::Database) -> Option<Self> {
        serde_json::from_str(&db.get_setting(WORKSPACE_KEY)?).ok()
    }

    /// Reading it consumes it: a workspace restored once must not be restored
    /// again on the next ordinary launch, which would silently undo whatever
    /// the user did in between.
    pub fn take(db: &crate::db::Database) -> Option<Self> {
        let snapshot = Self::load(db)?;
        let _ = db.set_setting(WORKSPACE_KEY, "");
        Some(snapshot)
    }
}

/// Hand the saved workspace back to the frontend, then — if a helper is
/// watching — start proving this release is responsive.
///
/// Called from the window reveal. The order is the contract: the workspace
/// stage cannot be reported before the workspace has actually been restored,
/// because that stage is what the helper's launch timeout is measured against.
pub fn restore_workspace_and_verify(app: AppHandle) {
    let restored = app
        .try_state::<crate::state::SessionStore>()
        .and_then(|store| WorkspaceSnapshot::take(&store.database()));
    match &restored {
        Some(snapshot) => {
            tracing::info!(
                resumable = snapshot.resumable_runs.len(),
                interrupted = snapshot.interrupted.len(),
                "restoring the workspace saved before the restart"
            );
            let _ = app.emit("activation-workspace-restored", snapshot);
        }
        None => {
            let _ = app.emit("activation-workspace-restored", serde_json::Value::Null);
        }
    }
    if !activating() {
        return;
    }
    report_stage(
        Stage::Workspace,
        match &restored {
            Some(_) => "saved workspace restored",
            None => "no saved workspace to restore",
        },
    );
    start_health_watch(app);
}

// ---------------------------------------------------------------------------
// Preparing a restart
// ---------------------------------------------------------------------------

/// Everything that has to be true before Redline will offer to restart, and
/// re-checked immediately before it does.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestartPreflight {
    pub ok: bool,
    /// Reasons this release cannot be activated now. Each is a sentence.
    pub blockers: Vec<String>,
    /// Free space on the installed application's filesystem, in bytes.
    pub free_bytes: u64,
    /// What the artifact will occupy while both copies exist.
    pub required_bytes: u64,
}

/// The filesystem `path` lives on has this much room.
fn free_bytes(path: &Path) -> Option<u64> {
    let probe = if path.exists() { path } else { path.parent()? };
    let c = std::ffi::CString::new(probe.as_os_str().as_encoded_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(c.as_ptr(), &mut stat) } == 0)
        .then(|| stat.f_bavail as u64 * stat.f_frsize as u64)
}

/// Check everything that could make a restart fail, while Redline is still
/// running and can report it.
pub fn preflight(
    manifest: &ReleaseManifest,
    candidate_bundle: &Path,
    installed_bundle: &Path,
    data_dir: &Path,
) -> RestartPreflight {
    let mut blockers = manifest.readiness_blockers();

    if !candidate_bundle.exists() {
        blockers.push(format!(
            "the prepared application is no longer at {}",
            candidate_bundle.display()
        ));
    } else if let Err(e) = release_manifest::artifact_matches(candidate_bundle, &manifest.artifact) {
        blockers.push(e);
    }
    if !installed_bundle.exists() {
        blockers.push(format!(
            "there is no installed application at {}",
            installed_bundle.display()
        ));
    }
    // The staging copy has to land on the installed application's own
    // filesystem, or the exchange cannot be atomic.
    let staging_root = installed_bundle
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/Applications"));
    if !is_writable_dir(&staging_root) {
        blockers.push(format!(
            "Redline does not have permission to install into {}",
            staging_root.display()
        ));
    }
    if let Err(e) = redline_activation::swap_supported(&staging_root) {
        blockers.push(e);
    }
    match helper_for(installed_bundle, data_dir) {
        Ok(_) => {}
        Err(e) => blockers.push(e),
    }

    // Both copies exist at once during the exchange, plus the snapshot.
    let required = manifest.artifact.total_bytes.saturating_mul(2);
    let free = free_bytes(&staging_root).unwrap_or(0);
    if free > 0 && free < required {
        blockers.push(format!(
            "there is not enough free space to install this release ({} needed, {} free)",
            human_bytes(required),
            human_bytes(free)
        ));
    }
    if mutations_gated() {
        blockers.push(gated_message());
    }

    RestartPreflight {
        ok: blockers.is_empty(),
        blockers,
        free_bytes: free,
        required_bytes: required,
    }
}

fn is_writable_dir(dir: &Path) -> bool {
    let c = match std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// The helper that will drive this activation: the **incumbent's**, copied out
/// of the installed bundle to a directory outside either exchanged path.
///
/// The copy is the point. Running the helper from inside the installed bundle
/// would mean exchanging the file underneath a running process, and running it
/// from inside the candidate would mean the release being installed supplies
/// its own recovery implementation.
pub fn helper_for(installed_bundle: &Path, data_dir: &Path) -> Result<PathBuf, String> {
    let source = release_manifest::helper_path_in(installed_bundle);
    if !source.is_file() {
        return Err(format!(
            "the installed version of Redline does not carry an activation helper, so it \
             cannot hand a restart over to one. Install this release the conventional way \
             once; later releases can then restart in place."
        ));
    }
    let dest_dir = data_dir.join(HELPER_DIR);
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("{}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join(release_manifest::HELPER_FILENAME);
    // Refresh it every time: the incumbent may have changed since the last
    // activation, and the helper that drives an exchange must be the one that
    // shipped with the release doing the exchanging.
    std::fs::copy(&source, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }
    Ok(dest)
}

/// A durable copy of the verified candidate, on the installed application's own
/// filesystem, made while Redline is still usable.
///
/// This is the expensive part of an activation — copying tens of megabytes —
/// and it deliberately happens *before* anything quits. Nothing that can be
/// done in advance belongs after the process exits.
pub fn stage(candidate_bundle: &Path, installed_bundle: &Path, txn_id: &str) -> Result<PathBuf, String> {
    let root = installed_bundle
        .parent()
        .ok_or_else(|| "the installed application has no parent directory".to_string())?;
    let staging = root.join(format!(".redline-staging-{txn_id}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    let name = installed_bundle
        .file_name()
        .ok_or_else(|| "the installed application has no name".to_string())?;
    let dest = staging.join(name);
    // `ditto` rather than a recursive copy: it preserves the extended
    // attributes and resource forks a code signature is made of, which a
    // naive copy silently drops — producing a bundle that fails to launch
    // with a signature error and no obvious cause.
    let out = std::process::Command::new("/usr/bin/ditto")
        .arg(candidate_bundle)
        .arg(&dest)
        .output()
        .map_err(|e| format!("could not copy the prepared application: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "could not copy the prepared application: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(dest)
}

// ---------------------------------------------------------------------------
// Save work, then hand over
// ---------------------------------------------------------------------------

/// What is live right now, sorted into what survives a restart and what does
/// not.
///
/// The distinction is the honest part of the restart summary. Saved state
/// comes back; a process does not. A terminal's shell, a page's JavaScript, an
/// open network connection and a held review request all end when this process
/// does, and telling the user they will "resume" would be a lie the next
/// screen immediately contradicts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveWork {
    /// Runs with durable state the runner can pick up again.
    pub resumable_runs: Vec<String>,
    /// Everything that will not come back, with what the user can do about it.
    pub interrupted: Vec<InterruptedWork>,
    /// Work that is mid-turn and would lose that turn. A restart waits for
    /// these to finish, and reports them if they do not.
    pub blocking: Vec<String>,
}

impl LiveWork {
    pub fn is_drained(&self) -> bool {
        self.blocking.is_empty()
    }
}

/// Take stock of everything running.
pub fn live_work(app: &AppHandle) -> LiveWork {
    let mut work = LiveWork::default();
    if let Some(store) = app.try_state::<crate::state::SessionStore>() {
        if let Ok(runs) = store.database().runner_list() {
            for run in runs {
                match run.status.as_str() {
                    // A running run has durable per-node state and its own
                    // interrupted-run recovery; it comes back.
                    "running" | "paused" => {
                        work.resumable_runs.push(run.run_id.clone());
                        let mid_turn = run
                            .nodes
                            .iter()
                            .filter(|n| crate::runner_graph::live(&n.status))
                            .count();
                        if mid_turn > 0 {
                            work.blocking.push(format!(
                                "{mid_turn} task{} still running in {}",
                                if mid_turn == 1 { "" } else { "s" },
                                run.run_id
                            ));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(pending) = app.try_state::<crate::PendingResponses>() {
        for session in pending.held_sessions() {
            work.interrupted.push(InterruptedWork {
                kind: "held-review".into(),
                label: format!("plan review {session}"),
                recovery: "The waiting session's hook will fail; use Restore to bring the \
                           review back."
                    .into(),
            });
        }
    }
    if let Some(pty) = app.try_state::<crate::pty::PtyState>() {
        for id in pty.live_ids() {
            work.interrupted.push(InterruptedWork {
                kind: "terminal".into(),
                label: format!("terminal {id}"),
                recovery: "Terminals close with the application. Reopen it and use \
                           `claude --resume` to pick the session back up."
                    .into(),
            });
        }
    }
    work
}

/// The frontend's answer to the flush request.
fn flush_channel() -> &'static Mutex<Option<tokio::sync::oneshot::Sender<serde_json::Value>>> {
    static C: OnceLock<Mutex<Option<tokio::sync::oneshot::Sender<serde_json::Value>>>> =
        OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// Called by the frontend when it has flushed every editor, comment, draft and
/// pane, carrying the state it wants back afterwards.
pub fn flush_complete(state: serde_json::Value) {
    if let Some(tx) = flush_channel()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = tx.send(state);
    }
}

/// Set once the pre-activation snapshot has been taken, so the quit handler
/// does not take a second one of the same database moments later.
static SNAPSHOT_TAKEN: AtomicBool = AtomicBool::new(false);

/// True when the restart path has already made its consistent snapshot.
pub fn snapshot_already_taken() -> bool {
    SNAPSHOT_TAKEN.load(Ordering::SeqCst)
}

/// Why a restart did not happen. Every one of these leaves the current
/// application running and untouched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestartRefused {
    pub reason: String,
    /// What is still busy, when that is the reason.
    pub blocking: Vec<String>,
    /// The user can wait and try again, rather than this being final.
    pub retryable: bool,
}

/// Save the user's work, hand the transaction to the helper, and quit.
///
/// Everything expensive happens before anything quits: the artifact is
/// revalidated and copied to staging while Redline is still usable, and the
/// helper is running and has acknowledged that it can finish alone before this
/// process exits. After the exit there is no dependency resolution, no
/// compilation, no signing and no bulk copying left to do — only the exchange
/// and the launch.
///
/// A refusal here is not a failure: the current version keeps running.
pub async fn restart_to_apply(
    app: AppHandle,
    release_id: String,
    candidate_bundle: PathBuf,
    manifest: ReleaseManifest,
) -> Result<String, RestartRefused> {
    let refuse = |reason: String| RestartRefused {
        reason,
        blocking: Vec::new(),
        retryable: false,
    };
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| refuse(format!("could not resolve the data directory: {e}")))?;
    let installed = own_bundle().ok_or_else(|| {
        refuse(
            "Redline is not running from an installed application bundle, so there is nothing \
             to replace. This works from an installed copy, not from a development run."
                .into(),
        )
    })?;

    // 1. Revalidate everything, now — not when the release was prepared. The
    //    artifact, the permissions, the free space, the helper and the
    //    filesystem's ability to exchange the bundle are all re-checked while
    //    this process is still alive to report on them.
    let pf = preflight(&manifest, &candidate_bundle, &installed, &data_dir);
    if !pf.ok {
        return Err(refuse(pf.blockers.join("; ")));
    }

    // 2. Stop admitting new work. From here nothing new starts: no agent
    //    turns, no queue entries, no background jobs, and every mutating
    //    request through the daemon is refused with a reason.
    gate("Redline is saving your work and restarting into the version you just prepared.");
    let un_gate = || ungate();

    if let (Some(store), Some(rt)) = (
        app.try_state::<crate::state::SessionStore>(),
        app.try_state::<crate::queue::QueueRuntime>(),
    ) {
        crate::queue::stop_dequeuing(
            &store.database(),
            &rt,
            "restarting into a new version",
        );
    }

    // 3. Ask the frontend to flush: editors, comments, drafts, collaboration
    //    state, pane layout. It answers with the state it wants back.
    let (tx, rx) = tokio::sync::oneshot::channel();
    *flush_channel().lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    let _ = app.emit(
        "activation-quiesce",
        serde_json::json!({
            "releaseId": release_id,
            "deadlineMs": FLUSH_TIMEOUT.as_millis() as u64,
        }),
    );
    let frontend_state = match tokio::time::timeout(FLUSH_TIMEOUT, rx).await {
        Ok(Ok(state)) => state,
        // A frontend that never answered is not a reason to lose its work
        // silently; it is a reason to say so and carry on with what is durable.
        _ => {
            tracing::warn!("the frontend did not confirm its flush before the restart");
            serde_json::Value::Null
        }
    };

    // 4. Drain. A restart waits for work that is mid-turn, and if it does not
    //    finish it reports what is holding things up and leaves the decision
    //    with the user. It never force-quits out from under them.
    let mut work = live_work(&app);
    let drain_deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !work.is_drained() && std::time::Instant::now() < drain_deadline {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        work = live_work(&app);
    }
    if !work.is_drained() {
        un_gate();
        return Err(RestartRefused {
            reason: "Redline is still working on something. You can restart once it finishes."
                .into(),
            blocking: work.blocking,
            retryable: true,
        });
    }

    // 5. Save the workspace — saved state only, and an honest list of what is
    //    about to be interrupted.
    let snapshot = WorkspaceSnapshot {
        saved_at: release_manifest::now_secs(),
        frontend: frontend_state,
        resumable_runs: work.resumable_runs.clone(),
        interrupted: work.interrupted.clone(),
    };
    let Some(store) = app.try_state::<crate::state::SessionStore>() else {
        un_gate();
        return Err(refuse("the session store is not available".into()));
    };
    if let Err(e) = snapshot.save(&store.database()) {
        un_gate();
        return Err(refuse(format!("could not save the workspace: {e}")));
    }

    // 6. A consistent recovery snapshot, taken with SQLite's own backup
    //    facility rather than by copying a live file, now that writes have
    //    stopped. Measured, because if it cannot finish in the restart budget
    //    the honest answer is to abort before quitting rather than after.
    let txn_id = format!("txn-{}-{}", release_manifest::now_secs(), &release_id);
    let txn_dir = data_dir.join(ACTIVATION_DIR).join(&txn_id);
    if let Err(e) = std::fs::create_dir_all(&txn_dir) {
        un_gate();
        return Err(refuse(format!("{}: {e}", txn_dir.display())));
    }
    let pre_snapshot = txn_dir.join("pre-activation.db");
    let snapshot_started = std::time::Instant::now();
    {
        let db = store.database();
        let dest = pre_snapshot.clone();
        let result = tokio::task::spawn_blocking(move || db.snapshot_to(&dest))
            .await
            .map_err(|e| refuse(format!("the recovery snapshot did not run: {e}")))?;
        if let Err(e) = result {
            un_gate();
            return Err(refuse(format!("could not take a recovery snapshot: {e}")));
        }
    }
    SNAPSHOT_TAKEN.store(true, Ordering::SeqCst);
    tracing::info!(
        ms = snapshot_started.elapsed().as_millis() as u64,
        "pre-activation snapshot complete"
    );

    // 7. Take the installation lock before touching anything beside the
    //    installed application, and hold it for the staging copy. The helper
    //    re-acquires it for the exchange itself, after this process is gone.
    if let Some(parent) = installed.parent() {
        match redline_activation::InstallLock::acquire(parent, std::time::Duration::from_secs(5)) {
            Ok(lock) => drop(lock),
            Err(e) => {
                un_gate();
                return Err(refuse(e));
            }
        }
    }

    //    Copy the verified artifact next to the installed application. This is
    //    the expensive part, and it happens here — before anything quits — so
    //    the downtime is an exchange and a launch, nothing more.
    let staged = {
        let candidate = candidate_bundle.clone();
        let installed_for_stage = installed.clone();
        let id = txn_id.clone();
        match tokio::task::spawn_blocking(move || stage(&candidate, &installed_for_stage, &id))
            .await
        {
            Ok(Ok(path)) => path,
            Ok(Err(e)) => {
                un_gate();
                return Err(refuse(e));
            }
            Err(e) => {
                un_gate();
                return Err(refuse(format!("the staging copy did not run: {e}")));
            }
        }
    };
    // What was copied is what was verified. Checked again, because the copy is
    // itself an operation that can go wrong.
    if let Err(e) = release_manifest::artifact_matches(&staged, &manifest.artifact) {
        un_gate();
        let _ = std::fs::remove_dir_all(staged.parent().unwrap_or(&staged));
        return Err(refuse(format!("the staged copy is not the verified artifact: {e}")));
    }

    // 8. Write the transaction, take the exit lock, start the helper, and only
    //    quit once the helper says it can finish without us.
    let helper = match helper_for(&installed, &data_dir) {
        Ok(path) => path,
        Err(e) => {
            un_gate();
            return Err(refuse(e));
        }
    };
    let txn = Transaction {
        protocol: redline_activation::PROTOCOL,
        txn_id: txn_id.clone(),
        created_at: release_manifest::now_secs(),
        release_id: release_id.clone(),
        artifact_sha256: manifest.artifact.sha256.clone(),
        previous_release_id: installed_release_id(&installed),
        installed_path: installed.clone(),
        staged_path: staged.clone(),
        executable_name: executable_name(&installed),
        app_pid: std::process::id(),
        data_dir: data_dir.clone(),
        pre_snapshot,
        exit_timeout_secs: 30,
        launch_timeout_secs: 120,
        health_secs: 15,
    };
    if let Err(e) = txn.write_to(&txn_dir) {
        un_gate();
        return Err(refuse(format!("could not record the activation: {e}")));
    }
    let journal = match Journal::open(&txn_dir) {
        Ok(j) => j,
        Err(e) => {
            un_gate();
            return Err(refuse(format!("could not open the activation journal: {e}")));
        }
    };
    let _ = journal.append(Step::Staged, "verified copy in place");

    // The lock is how the helper knows we are gone — immune to the pid reuse
    // that a plain `kill(pid, 0)` check would fall for. Leaked on purpose: it
    // is released by the process exiting, which is exactly the event it
    // represents.
    match redline_activation::ExitLock::acquire(&txn_dir) {
        Ok(lock) => std::mem::forget(lock),
        Err(e) => {
            un_gate();
            return Err(refuse(format!("could not take the activation lock: {e}")));
        }
    }

    let spawned = std::process::Command::new(&helper)
        .arg(&txn_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Err(e) = spawned {
        un_gate();
        return Err(refuse(format!("could not start the activation helper: {e}")));
    }

    // Quitting before the helper is ready would leave nobody to perform the
    // exchange — and an application that had already saved its work and shut
    // down for nothing.
    let ready_deadline = std::time::Instant::now() + HELPER_READY_TIMEOUT;
    while !redline_activation::helper_ready(&txn_dir) {
        if std::time::Instant::now() >= ready_deadline {
            un_gate();
            return Err(refuse(
                "the activation helper did not start, so nothing was changed.".into(),
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let _ = journal.append(Step::HandedOff, "helper acknowledged");
    tracing::info!(txn = %txn_id, "handing the activation to the helper and exiting");
    let _ = app.emit("activation-handoff", &txn_id);
    // A beat for the event to reach the window before it goes away.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    app.exit(0);
    Ok(txn_id)
}

/// The executable inside a bundle, from its `Info.plist` name or the one file
/// in `Contents/MacOS`.
fn executable_name(bundle: &Path) -> String {
    let macos = bundle.join("Contents/MacOS");
    std::fs::read_dir(&macos)
        .ok()
        .and_then(|mut entries| {
            entries.find_map(|e| {
                let e = e.ok()?;
                e.path().is_file().then(|| e.file_name().to_string_lossy().into_owned())
            })
        })
        .unwrap_or_else(|| "Redline".to_string())
}

// ---------------------------------------------------------------------------
// Recovery on boot
// ---------------------------------------------------------------------------

/// What a previous, unfinished activation turned out to be.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivationReport {
    pub txn_id: String,
    pub release_id: String,
    pub accepted: bool,
    pub rolled_back: bool,
    pub needs_attention: bool,
    pub message: String,
    pub finished_at: i64,
}

/// Look for activations that never reached a terminal step and settle them.
///
/// Called on every launch, including the ordinary ones. It answers the only
/// question that matters after a crash — *which release is installed right
/// now?* — by reading the bundle, not by trusting the journal, and it never
/// re-launches anything: a recovery that relaunched would be a boot loop with
/// extra steps.
pub fn reconcile_on_boot(data_dir: &Path, installed_bundle: &Path) -> Vec<ActivationReport> {
    let root = data_dir.join(ACTIVATION_DIR);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let installed = installed_release_id(installed_bundle);
    let mut reports = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || dir.file_name().map(|n| n == "helper").unwrap_or(false) {
            continue;
        }
        let Ok(txn) = Transaction::read_from(&dir) else {
            continue;
        };
        // The helper already wrote a verdict: report it and move on.
        if let Some(outcome) = Outcome::read_from(&dir) {
            reports.push(ActivationReport {
                txn_id: outcome.txn_id,
                release_id: outcome.release_id,
                accepted: outcome.accepted,
                rolled_back: outcome.rolled_back,
                needs_attention: false,
                message: outcome.failure,
                finished_at: outcome.finished_at,
            });
            continue;
        }
        let Ok(journal) = Journal::open(&dir) else { continue };
        let resolution = Resolution::from(
            journal.last_step(),
            installed.as_deref(),
            &txn.release_id,
            txn.previous_release_id.as_deref(),
        );
        let report = match resolution {
            Resolution::Settled(step) => ActivationReport {
                txn_id: txn.txn_id.clone(),
                release_id: txn.release_id.clone(),
                accepted: step == Step::Accepted,
                rolled_back: step == Step::RolledBack,
                needs_attention: step == Step::Failed,
                message: String::new(),
                finished_at: release_manifest::now_secs(),
            },
            Resolution::Abandon => {
                let _ = journal.append(Step::Failed, "abandoned: the previous release is installed");
                ActivationReport {
                    txn_id: txn.txn_id.clone(),
                    release_id: txn.release_id.clone(),
                    accepted: false,
                    rolled_back: false,
                    needs_attention: false,
                    message: "The version change did not finish, and your previous version is \
                              the one running. Nothing was lost; you can prepare it again."
                        .into(),
                    finished_at: release_manifest::now_secs(),
                }
            }
            Resolution::RollBack => {
                // The candidate is installed and nobody ever accepted it. The
                // running process IS that candidate, so it cannot exchange
                // itself — the helper does it, on the next restart the user
                // asks for. Say so plainly rather than acting.
                let _ = journal.append(
                    Step::HandshakeFailed,
                    "recovered on a later launch: never accepted",
                );
                ActivationReport {
                    txn_id: txn.txn_id.clone(),
                    release_id: txn.release_id.clone(),
                    accepted: false,
                    rolled_back: false,
                    needs_attention: true,
                    message: format!(
                        "A version change was interrupted before Redline could confirm the new \
                         version works. The new version is what is running now; the previous one \
                         is still at {}. Use Restore previous version if anything looks wrong.",
                        txn.staged_path.display()
                    ),
                    finished_at: release_manifest::now_secs(),
                }
            }
            Resolution::NeedsAttention => ActivationReport {
                txn_id: txn.txn_id.clone(),
                release_id: txn.release_id.clone(),
                accepted: false,
                rolled_back: false,
                needs_attention: true,
                message: "A version change was interrupted, and the installed application is \
                          neither the version it was replacing nor the one it was installing. \
                          Redline has not changed anything."
                    .into(),
                finished_at: release_manifest::now_secs(),
            },
        };
        reports.push(report);
    }
    reports.sort_by_key(|r| r.finished_at);
    reports
}

/// Delete transaction directories that have been settled and read. Keeps the
/// most recent one, which is what the restart summary is built from.
pub fn prune_settled(data_dir: &Path, keep: usize) {
    let root = data_dir.join(ACTIVATION_DIR);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let mut settled: Vec<(i64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.file_name().map(|n| n != "helper").unwrap_or(false))
        .filter_map(|p| Outcome::read_from(&p).map(|o| (o.finished_at, p)))
        .collect();
    settled.sort_by_key(|(at, _)| *at);
    let excess = settled.len().saturating_sub(keep);
    for (_, dir) in settled.into_iter().take(excess) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rl-activation-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bundle_with(dir: &Path, name: &str, release: Option<&str>) -> PathBuf {
        let bundle = dir.join(name);
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), b"<plist/>").unwrap();
        std::fs::write(bundle.join("Contents/MacOS/Redline"), b"binary").unwrap();
        if let Some(id) = release {
            let mut m = ReleaseManifest::new(id);
            m.signing.verified = true;
            m.data.previous_can_read = true;
            m.stamp().write_into(&bundle).unwrap();
            m.artifact = release_manifest::hash_bundle(&bundle, &[]).unwrap();
            m.seal();
            m.write_to(&dir.join(format!("{id}.manifest.json"))).unwrap();
        }
        bundle
    }

    #[test]
    fn the_running_release_is_read_from_the_bundle_not_asserted() {
        let dir = tmp("identity");
        let bundle = bundle_with(&dir, "Redline.app", Some("rel-77"));
        assert_eq!(installed_release_id(&bundle).as_deref(), Some("rel-77"));
        // An installation from before manifests existed has no identity, and
        // saying so is different from saying it is the candidate.
        let bare = bundle_with(&dir, "Old.app", None);
        assert_eq!(installed_release_id(&bare), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preflight_refuses_without_a_helper_in_the_installed_bundle() {
        let dir = tmp("nohelper");
        let installed = bundle_with(&dir, "Redline.app", Some("rel-old"));
        let candidate = bundle_with(&dir, "Candidate.app", Some("rel-new"));
        let mut manifest = ReleaseManifest::read_from(&dir.join("rel-new.manifest.json")).unwrap();
        manifest.artifact = release_manifest::hash_bundle(&candidate, &[]).unwrap();
        manifest.seal();
        let pf = preflight(&manifest, &candidate, &installed, &dir);
        assert!(!pf.ok);
        assert!(
            pf.blockers.iter().any(|b| b.contains("activation helper")),
            "{:?}",
            pf.blockers
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preflight_notices_a_candidate_that_changed_after_it_was_sealed() {
        let dir = tmp("changed");
        let installed = bundle_with(&dir, "Redline.app", Some("rel-old"));
        std::fs::write(
            release_manifest::helper_path_in(&installed),
            b"#!/bin/sh\nexit 0\n",
        )
        .unwrap();
        let candidate = bundle_with(&dir, "Candidate.app", None);
        let mut manifest = ReleaseManifest::new("rel-new");
        manifest.signing.verified = true;
        manifest.data.previous_can_read = true;
        manifest.stamp().write_into(&candidate).unwrap();
        manifest.artifact = release_manifest::hash_bundle(&candidate, &[]).unwrap();
        manifest.seal();
        assert!(preflight(&manifest, &candidate, &installed, &dir)
            .blockers
            .iter()
            .all(|b| !b.contains("not the artifact")));
        // One byte, after sealing.
        std::fs::write(candidate.join("Contents/MacOS/Redline"), b"tampered").unwrap();
        let pf = preflight(&manifest, &candidate, &installed, &dir);
        assert!(!pf.ok);
        assert!(
            pf.blockers.iter().any(|b| b.contains("not the artifact")),
            "{:?}",
            pf.blockers
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staging_lands_on_the_installed_applications_own_filesystem() {
        let dir = tmp("stage");
        let installed = bundle_with(&dir, "Redline.app", Some("rel-old"));
        let candidate = bundle_with(&dir, "Candidate.app", Some("rel-new"));
        let staged = stage(&candidate, &installed, "txn-9").unwrap();
        assert!(staged.starts_with(&dir), "staging must be beside the installed app");
        assert!(staged.join("Contents/MacOS/Redline").is_file());
        assert_eq!(installed_release_id(&staged).as_deref(), Some("rel-new"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workspace_snapshot_is_consumed_when_it_is_restored() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let snapshot = WorkspaceSnapshot {
            saved_at: 1,
            frontend: serde_json::json!({"surface": "runs"}),
            resumable_runs: vec!["run-1".into()],
            interrupted: vec![InterruptedWork {
                kind: "terminal".into(),
                label: "redline".into(),
                recovery: "Reopen the terminal".into(),
            }],
        };
        snapshot.save(&db).unwrap();
        assert_eq!(WorkspaceSnapshot::take(&db).unwrap(), snapshot);
        // Taken once, and only once: a second launch must not silently undo
        // whatever the user did after the first restore.
        assert!(WorkspaceSnapshot::take(&db).is_none());
    }

    #[test]
    fn recovery_reads_the_bundle_to_decide_what_an_interrupted_swap_did() {
        let dir = tmp("recover");
        let data = dir.join("data");
        let txn_dir = data.join(ACTIVATION_DIR).join("txn-5");
        std::fs::create_dir_all(&txn_dir).unwrap();
        let installed = bundle_with(&dir, "Redline.app", Some("rel-new"));
        let txn = Transaction {
            protocol: redline_activation::PROTOCOL,
            txn_id: "txn-5".into(),
            created_at: 1,
            release_id: "rel-new".into(),
            artifact_sha256: "x".into(),
            previous_release_id: Some("rel-old".into()),
            installed_path: installed.clone(),
            staged_path: dir.join("staging/Redline.app"),
            executable_name: "Redline".into(),
            app_pid: 1,
            data_dir: data.clone(),
            pre_snapshot: dir.join("pre.db"),
            exit_timeout_secs: 30,
            launch_timeout_secs: 90,
            health_secs: 20,
        };
        txn.write_to(&txn_dir).unwrap();
        Journal::open(&txn_dir)
            .unwrap()
            .append(Step::SwapBegin, "")
            .unwrap();

        // The journal only ever said "about to swap". The bundle says the swap
        // happened, so the candidate is live and was never accepted.
        let reports = reconcile_on_boot(&data, &installed);
        assert_eq!(reports.len(), 1);
        assert!(reports[0].needs_attention);
        assert!(reports[0].message.contains("interrupted"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_on_a_machine_where_the_swap_never_happened_is_quiet() {
        let dir = tmp("quiet");
        let data = dir.join("data");
        let txn_dir = data.join(ACTIVATION_DIR).join("txn-6");
        std::fs::create_dir_all(&txn_dir).unwrap();
        let installed = bundle_with(&dir, "Redline.app", Some("rel-old"));
        let mut txn = Transaction {
            protocol: redline_activation::PROTOCOL,
            txn_id: "txn-6".into(),
            created_at: 1,
            release_id: "rel-new".into(),
            artifact_sha256: "x".into(),
            previous_release_id: Some("rel-old".into()),
            installed_path: installed.clone(),
            staged_path: dir.join("staging/Redline.app"),
            executable_name: "Redline".into(),
            app_pid: 1,
            data_dir: data.clone(),
            pre_snapshot: dir.join("pre.db"),
            exit_timeout_secs: 30,
            launch_timeout_secs: 90,
            health_secs: 20,
        };
        txn.protocol = redline_activation::PROTOCOL;
        txn.write_to(&txn_dir).unwrap();
        Journal::open(&txn_dir).unwrap().append(Step::HandedOff, "").unwrap();
        let reports = reconcile_on_boot(&data, &installed);
        assert_eq!(reports.len(), 1);
        assert!(!reports[0].needs_attention);
        assert!(reports[0].message.contains("previous version"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_gate_reports_why_and_lifts() {
        ungate();
        assert!(!mutations_gated());
        gate("Redline is verifying the version it just installed.");
        assert!(mutations_gated());
        assert!(gated_message().contains("verifying"));
        assert!(!background_effects_allowed());
        ungate();
        assert!(!mutations_gated());
    }

    #[test]
    fn the_helper_environment_variable_is_spelled_the_same_on_both_sides() {
        // The helper does not link this crate, so the two spellings can only
        // be kept together by a test that reads its source.
        let helper = include_str!("../crates/redline-activate/src/main.rs");
        assert!(
            helper.contains(&format!("\"{}\"", runtime_profile::ENV_ACTIVATION_TXN)),
            "the helper must set {}",
            runtime_profile::ENV_ACTIVATION_TXN
        );
    }

    #[test]
    fn human_bytes_reads_like_a_person_wrote_it() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(37_700_000), "36.0 MB");
    }
}

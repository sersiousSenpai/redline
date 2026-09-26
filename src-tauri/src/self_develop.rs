// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Building Redline inside Redline.
//!
//! An approved plan becomes background agent work in an isolated copy of the
//! source, a complete replacement application, and — once that application has
//! been built, checked, signed and *started* — an offer to restart into it.
//!
//! The whole design is one separation: **preparing** a change is not
//! **activating** it. Preparation can take an hour, can touch Redline's own
//! startup code, and can fail; none of that is allowed to disturb the copy the
//! user is working in. Activation is short, recoverable, and happens only when
//! the user says so.
//!
//! This module owns the preparation half:
//!
//! * [`capture`] — a candidate workspace, taken from the live checkout without
//!   sharing its git metadata, carrying the local modifications and untracked
//!   source that were actually there.
//! * [`Release`] — the durable record, separate from the run's task state,
//!   because "the tasks finished" and "there is an installable release" are
//!   different claims.
//! * [`prepare`] — the trusted pipeline: dependencies from lockfiles, checks,
//!   build, package, sign, probe, seal. Not nodes in the editable task graph:
//!   a user or an agent deleting a check node must not be able to turn an
//!   unverified candidate into an installable release.
//!
//! [`crate::activation`] owns the other half.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::release_manifest::{self, ReleaseManifest, SourceRef};

/// Where candidate workspaces live under the app data directory.
pub const CANDIDATES_DIR: &str = "self-develop";
/// Shared, designated build caches. Named in the confinement policy, so a
/// worker may write here and nowhere else outside its own candidate.
pub const CACHE_DIR: &str = "self-develop/cache";

/// `git`, by absolute path. A PATH lookup under a Finder launch finds nothing.
const GIT: &str = "/usr/bin/git";

/// Files that are never captured, whatever git thinks of them.
///
/// git's own ignore rules already keep `node_modules`, build output and the
/// like out. This list is about the other category: things that are tracked,
/// or untracked-but-not-ignored, and still must not be copied into a workspace
/// that agents and build scripts run inside.
const NEVER_CAPTURE: &[&str] = &[
    // The project-scoped hook configuration points at the real daemon and
    // carries its permissions. A candidate that inherited it would install
    // hooks for the user's live sessions.
    ".claude/settings.local.json",
    ".claude/settings.json",
    // Reserved: the path a build script would stage the activation helper at.
    // Nothing writes it today, and the entry is here so that if something ever
    // does, a compiled binary cannot ride into a candidate workspace as though
    // it were source.
    "src-tauri/resources/redline-activate",
];

/// Filename patterns that are never captured.
fn is_credential(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".token")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".keychain")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
}

/// Paths that are never captured because they are build output or metadata,
/// even when a checkout has them tracked or unignored.
fn is_excluded_path(rel: &str) -> bool {
    NEVER_CAPTURE.contains(&rel)
        || rel.starts_with(".git/")
        || rel == ".git"
        || rel.starts_with("node_modules/")
        || rel.contains("/node_modules/")
        || rel.starts_with("src-tauri/target/")
        || rel.starts_with("dist/")
        || rel.starts_with("dist-viewer/")
        || is_credential(rel)
}

/// What a capture found, before any agent has touched it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapture {
    /// The checkout this came from. Recorded so a temporary build directory
    /// can never become the updater's idea of where Redline's source lives.
    pub repository: String,
    pub base_revision: String,
    pub fingerprint: String,
    pub file_count: usize,
    /// Tracked files that differed from `base_revision`. Shown during run
    /// review: these came along for the ride and the reviewer should know.
    pub modified: Vec<String>,
    /// Untracked, unignored source that was included.
    pub untracked: Vec<String>,
    /// Files that were deliberately left out, with the reason.
    pub excluded: Vec<String>,
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(GIT)
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn nul_list(text: &str) -> Vec<String> {
    text.split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Which files a capture of `repo` would include, and which it would not.
///
/// Split out from the copying so the decision is testable on a fixture without
/// moving tens of thousands of files.
pub fn plan_capture(repo: &Path) -> Result<(Vec<String>, SourceCapture), String> {
    let base = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    let tracked = nul_list(&git(repo, &["ls-files", "-z"])?);
    // `--exclude-standard` is what makes this "untracked *source*" rather than
    // "everything in the working directory": it applies .gitignore, so build
    // output and dependency directories never appear.
    let untracked = nul_list(&git(
        repo,
        &["ls-files", "-z", "--others", "--exclude-standard"],
    )?);
    let modified: Vec<String> = nul_list(&git(repo, &["diff", "-z", "--name-only", "HEAD"])?);

    let mut included = Vec::with_capacity(tracked.len() + untracked.len());
    let mut excluded = Vec::new();
    for rel in tracked.iter().chain(untracked.iter()) {
        if is_excluded_path(rel) {
            excluded.push(rel.clone());
        } else {
            included.push(rel.clone());
        }
    }
    included.sort();
    included.dedup();
    excluded.sort();
    excluded.dedup();

    let capture = SourceCapture {
        repository: repo.to_string_lossy().into_owned(),
        base_revision: base,
        fingerprint: String::new(),
        file_count: included.len(),
        modified: modified
            .into_iter()
            .filter(|r| !is_excluded_path(r))
            .collect(),
        untracked: untracked
            .into_iter()
            .filter(|r| !is_excluded_path(r))
            .collect(),
        excluded,
    };
    Ok((included, capture))
}

/// Copy the live checkout into a private candidate workspace.
///
/// The candidate gets its **own** repository rather than sharing the live
/// checkout's git metadata: agents commit nothing, the user's branches and
/// stashes are not reachable from it, and the baseline commit made here is
/// what every later diff is taken against. The user's own checkout is left
/// exactly as it was — including the substantial uncommitted work that is
/// normally sitting in it.
pub fn capture(repo: &Path, candidate_root: &Path) -> Result<SourceCapture, String> {
    if !repo.join(".git").exists() {
        return Err(format!("{} is not a git checkout", repo.display()));
    }
    let (files, mut capture) = plan_capture(repo)?;
    if files.is_empty() {
        return Err(format!("{} has no source files to capture", repo.display()));
    }
    let _ = std::fs::remove_dir_all(candidate_root);
    std::fs::create_dir_all(candidate_root)
        .map_err(|e| format!("{}: {e}", candidate_root.display()))?;

    for rel in &files {
        let from = repo.join(rel);
        let to = candidate_root.join(rel);
        // A tracked path whose file is gone (deleted but not staged) is simply
        // absent from the candidate, which is what the working tree says.
        let Ok(meta) = std::fs::symlink_metadata(&from) else {
            continue;
        };
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        if meta.is_symlink() {
            let target = std::fs::read_link(&from).map_err(|e| format!("{}: {e}", from.display()))?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &to)
                .map_err(|e| format!("{}: {e}", to.display()))?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("{} -> {}: {e}", from.display(), to.display()))?;
        }
    }

    // A private repository, so "what did the agents change?" is a plain diff
    // and the answer cannot be confused with the user's own uncommitted work.
    git(candidate_root, &["init", "-q"])?;
    git(candidate_root, &["add", "-A"])?;
    git(
        candidate_root,
        &[
            "-c",
            "user.email=candidate@redline.invalid",
            "-c",
            "user.name=Redline candidate baseline",
            "commit",
            "-q",
            "--no-gpg-sign",
            "-m",
            "candidate baseline",
        ],
    )?;

    let (fingerprint, count) = release_manifest::fingerprint_source(candidate_root)?;
    capture.fingerprint = fingerprint;
    capture.file_count = count;
    Ok(capture)
}

/// The agents' work, as a patch against the captured baseline.
///
/// Retained after installation: the same source review the user already uses
/// can apply it back to their own checkout, and a conflict there is a real
/// answer rather than a surprise.
pub fn candidate_patch(candidate_root: &Path) -> Result<String, String> {
    // Include untracked files the agents created, or a patch would silently
    // omit every new module.
    let _ = git(candidate_root, &["add", "-AN"]);
    git(candidate_root, &["diff", "--no-color", "HEAD"])
}

/// Files the agents changed, relative to the baseline.
pub fn candidate_changed_files(candidate_root: &Path) -> Result<Vec<String>, String> {
    let _ = git(candidate_root, &["add", "-AN"]);
    Ok(nul_list(&git(
        candidate_root,
        &["diff", "-z", "--name-only", "HEAD"],
    )?))
}

/// Would that patch apply cleanly to the user's checkout as it stands now?
///
/// Asked before offering to apply it, because the checkout has moved on: the
/// user has been working in it the whole time preparation was running.
pub fn patch_applies_cleanly(repo: &Path, patch: &str) -> Result<bool, String> {
    if patch.trim().is_empty() {
        return Ok(true);
    }
    use std::io::Write;
    let mut child = std::process::Command::new(GIT)
        .arg("-C")
        .arg(repo)
        .args(["apply", "--check", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("git apply: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(patch.as_bytes());
    }
    drop(child.stdin.take());
    let status = child.wait().map_err(|e| format!("git apply: {e}"))?;
    Ok(status.success())
}

/// Turn a capture into the manifest's source section.
pub fn source_ref(
    capture: &SourceCapture,
    plan_revisions: Vec<String>,
    installed_release: Option<String>,
) -> SourceRef {
    SourceRef {
        repository: capture.repository.clone(),
        base_revision: capture.base_revision.clone(),
        fingerprint: capture.fingerprint.clone(),
        file_count: capture.file_count,
        modified_files: capture.modified.clone(),
        untracked_files: capture.untracked.clone(),
        plan_revisions,
        installed_release,
    }
}

// ---------------------------------------------------------------------------
// The release record
// ---------------------------------------------------------------------------

/// Where a candidate release has got to.
///
/// Deliberately separate from the run's task state. "Every task passed" and
/// "there is a signed, probed, installable application" are different claims,
/// and conflating them is how a green run becomes an offer to restart into
/// something that was never packaged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseStatus {
    /// Agents are working in the candidate.
    Preparing,
    /// Checks, packaging, signing and the probe are running.
    Verifying,
    /// Sealed and installable. The restart is offered from here.
    Ready,
    /// The user chose to restart; work is being drained and saved.
    Quiescing,
    /// Handed to the helper; the exchange is happening.
    Activating,
    /// The new process is running and proving itself.
    CheckingStartup,
    /// Installed and accepted.
    Active,
    /// Preparation or activation failed. `failure` says how.
    Failed,
    /// Superseded: a later release was accepted, or the source moved on.
    Outdated,
    /// The user stopped it.
    Cancelled,
    /// Activated, failed its startup check, and the previous release was
    /// restored.
    RolledBack,
}

impl ReleaseStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseStatus::Preparing => "preparing",
            ReleaseStatus::Verifying => "verifying",
            ReleaseStatus::Ready => "ready",
            ReleaseStatus::Quiescing => "quiescing",
            ReleaseStatus::Activating => "activating",
            ReleaseStatus::CheckingStartup => "checkingStartup",
            ReleaseStatus::Active => "active",
            ReleaseStatus::Failed => "failed",
            ReleaseStatus::Outdated => "outdated",
            ReleaseStatus::Cancelled => "cancelled",
            ReleaseStatus::RolledBack => "rolledBack",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "preparing" => ReleaseStatus::Preparing,
            "verifying" => ReleaseStatus::Verifying,
            "ready" => ReleaseStatus::Ready,
            "quiescing" => ReleaseStatus::Quiescing,
            "activating" => ReleaseStatus::Activating,
            "checkingStartup" => ReleaseStatus::CheckingStartup,
            "active" => ReleaseStatus::Active,
            "failed" => ReleaseStatus::Failed,
            "outdated" => ReleaseStatus::Outdated,
            "cancelled" => ReleaseStatus::Cancelled,
            "rolledBack" => ReleaseStatus::RolledBack,
            _ => return None,
        })
    }

    /// Nothing more will happen to this release without the user starting
    /// something new.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ReleaseStatus::Active
                | ReleaseStatus::Failed
                | ReleaseStatus::Outdated
                | ReleaseStatus::Cancelled
                | ReleaseStatus::RolledBack
        )
    }

    /// Only from `Ready` may a restart be offered, and only one release at a
    /// time may be in the activation half.
    pub fn holds_activation(self) -> bool {
        matches!(
            self,
            ReleaseStatus::Quiescing | ReleaseStatus::Activating | ReleaseStatus::CheckingStartup
        )
    }

    /// The transitions the lifecycle allows. Anything else is a bug, and
    /// refusing it here is what keeps "ready to restart" from being reachable
    /// out of a failed preparation.
    pub fn can_move_to(self, next: ReleaseStatus) -> bool {
        use ReleaseStatus::*;
        match (self, next) {
            (a, b) if a == b => true,
            (Preparing, Verifying | Failed | Cancelled) => true,
            (Verifying, Ready | Preparing | Failed | Cancelled) => true,
            (Ready, Quiescing | Outdated | Failed | Cancelled | Verifying) => true,
            (Quiescing, Activating | Ready | Failed) => true,
            (Activating, CheckingStartup | RolledBack | Failed) => true,
            (CheckingStartup, Active | RolledBack | Failed) => true,
            _ => false,
        }
    }
}

/// One candidate release, as the UI and the restart path see it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub release_id: String,
    /// The native run whose agents prepared it, if any.
    pub run_id: Option<String>,
    /// The checkout it was captured from.
    pub repository: String,
    pub status: String,
    pub candidate_root: String,
    pub bundle_path: Option<String>,
    pub manifest: Option<ReleaseManifest>,
    pub capture: Option<SourceCapture>,
    pub probe: Option<crate::probe::ProbeReport>,
    /// A sentence for the user when something went wrong.
    pub failure: String,
    /// What the pipeline is doing right now.
    pub step: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Release {
    pub fn status(&self) -> ReleaseStatus {
        ReleaseStatus::parse(&self.status).unwrap_or(ReleaseStatus::Failed)
    }

    /// The restart is offered only from a sealed, ready release whose manifest
    /// still passes every check.
    pub fn is_restartable(&self) -> bool {
        self.status() == ReleaseStatus::Ready
            && self.bundle_path.is_some()
            && self.manifest.as_ref().map(|m| m.is_ready()).unwrap_or(false)
    }
}

/// Where a candidate's workspace and artifacts live.
pub fn candidate_root(data_dir: &Path, release_id: &str) -> PathBuf {
    data_dir.join(CANDIDATES_DIR).join(release_id).join("source")
}

pub fn candidate_out(data_dir: &Path, release_id: &str) -> PathBuf {
    data_dir.join(CANDIDATES_DIR).join(release_id).join("out")
}

pub fn cache_root(data_dir: &Path) -> PathBuf {
    data_dir.join(CACHE_DIR)
}

/// A fresh release identifier: sortable, and readable in a path.
pub fn new_release_id() -> String {
    format!(
        "rel-{}-{}",
        release_manifest::now_secs(),
        &uuid::Uuid::new_v4().to_string()[..8]
    )
}


// ---------------------------------------------------------------------------
// The trusted preparation pipeline
// ---------------------------------------------------------------------------

/// One command in the pipeline. Data, not code, so the pipeline can be read,
/// shown in the UI, and asserted on without running a build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    /// What the user sees.
    pub name: &'static str,
    /// Argv, run inside the candidate root.
    pub argv: Vec<&'static str>,
    /// A failure here fails the release. Everything that decides whether the
    /// candidate is installable is required; nothing else is in the list.
    pub required: bool,
    /// Its result is recorded in the manifest as a check.
    pub is_check: bool,
}

/// The pipeline, in order.
///
/// **This list is not part of the run's task graph, and that is deliberate.**
/// The graph is editable: a user can delete a node, an agent can propose one
/// fewer. If packaging and verification lived there, deleting a check node
/// would turn an unverified candidate into an installable release. They live
/// here instead, owned by Redline, and a run cannot reach `Ready` without them.
pub fn pipeline() -> Vec<PipelineStep> {
    vec![
        PipelineStep {
            name: "Resolve dependencies",
            // `ci`, not `install`: the lockfile is the input, and a
            // preparation that silently upgraded a dependency would be
            // building something other than what was reviewed.
            argv: vec!["npm", "ci", "--no-audit", "--no-fund"],
            required: true,
            is_check: false,
        },
        PipelineStep {
            name: "Frontend tests",
            argv: vec!["npm", "test", "--", "--run"],
            required: true,
            is_check: true,
        },
        PipelineStep {
            name: "Rust tests",
            argv: vec![
                "cargo",
                "test",
                "--manifest-path",
                "src-tauri/Cargo.toml",
                "--lib",
                "--",
                "--test-threads=4",
            ],
            required: true,
            is_check: true,
        },
        PipelineStep {
            name: "Build the activation helper",
            argv: vec![
                "cargo",
                "build",
                "--release",
                "--manifest-path",
                "src-tauri/Cargo.toml",
                "-p",
                "redline-activate",
            ],
            required: true,
            is_check: false,
        },
        PipelineStep {
            name: "Build and package the application",
            argv: vec!["npm", "run", "tauri", "build"],
            required: true,
            is_check: false,
        },
        PipelineStep {
            name: "Size budget",
            argv: vec!["node", "scripts/check-size.mjs", "--strict"],
            required: true,
            is_check: true,
        },
    ]
}

/// Where the bundle and the helper land, *relative to the cargo target
/// directory* — which preparation overrides.
///
/// Not relative to the candidate root, and that distinction is load-bearing:
/// `CARGO_TARGET_DIR` points at a shared cache so a second candidate does not
/// recompile the world, and with it set the bundler writes to
/// `<cache>/cargo-target/release/bundle/…`, not into the candidate's own
/// `src-tauri/target`. Looking for the artifact in the wrong place would read
/// as "the build finished but produced no application".
pub const BUNDLE_IN_TARGET: &str = "release/bundle/macos/Redline.app";
pub const HELPER_IN_TARGET: &str = "release/redline-activate";

/// Everything the pipeline needs, gathered by the caller so `prepare` itself
/// reads nothing from global state.
#[derive(Debug, Clone)]
pub struct PrepareContext {
    pub release_id: String,
    pub candidate_root: PathBuf,
    /// Where the sealed manifest, the probe report and the staged artifact go.
    pub out_dir: PathBuf,
    pub cache_root: PathBuf,
    /// The live application data directory — denied to every worker.
    pub data_dir: PathBuf,
    /// The installed application — denied to every worker.
    pub installed_bundle: Option<PathBuf>,
    /// The local code-signing identity, applied by the trusted controller and
    /// never by a command the candidate's own source could choose.
    pub signing_identity: Option<String>,
    pub plan_revisions: Vec<String>,
    pub capture: SourceCapture,
    /// A consistent snapshot of the live database, for the probe to open. Made
    /// with SQLite's backup facility, never by copying a live file.
    pub database_snapshot: Option<PathBuf>,
    pub installed_release: Option<String>,
    /// Longest a single pipeline step may run.
    pub step_timeout: std::time::Duration,
    /// Longest the probe may take to report.
    pub probe_timeout: std::time::Duration,
}

impl PrepareContext {
    /// Where cargo puts its output. Shared across candidates on purpose: a
    /// cold build of this application is tens of minutes, and the second one
    /// should not be.
    pub fn target_dir(&self) -> PathBuf {
        self.cache_root.join("cargo-target")
    }

    /// The packaged application `tauri build` produced.
    ///
    /// Checked in the overridden target directory first and the candidate's
    /// own second. The Tauri CLI locates the bundle through `cargo metadata`,
    /// which honours `CARGO_TARGET_DIR` — but "the artifact is wherever the
    /// bundler decided" is a fact about another tool's implementation, and the
    /// failure if it ever changes ("the build finished but produced no
    /// application") would send someone looking in entirely the wrong place.
    pub fn built_bundle(&self) -> PathBuf {
        let shared = self.target_dir().join(BUNDLE_IN_TARGET);
        if shared.is_dir() {
            return shared;
        }
        let local = self
            .candidate_root
            .join("src-tauri/target")
            .join(BUNDLE_IN_TARGET);
        if local.is_dir() {
            return local;
        }
        shared
    }

    /// The activation helper the build produced.
    pub fn built_helper(&self) -> PathBuf {
        let shared = self.target_dir().join(HELPER_IN_TARGET);
        if shared.is_file() {
            return shared;
        }
        let local = self
            .candidate_root
            .join("src-tauri/target")
            .join(HELPER_IN_TARGET);
        if local.is_file() {
            return local;
        }
        shared
    }

    /// What a worker may touch.
    ///
    /// Reads stay broad (a build reads the whole toolchain); writes are the
    /// candidate, its output and the designated caches, and nothing else. The
    /// installed application, the live data directory and the user's hook
    /// configuration are closed to reads as well — a build script that can
    /// read the daemon token is a build script that can drive the application
    /// it is replacing.
    pub fn worker_policy(&self) -> crate::confine::Policy {
        let mut policy = crate::confine::Policy::default()
            .denied(&self.data_dir)
            .denied(claude_config_dir())
            .denied_port(crate::runtime_profile::PRODUCTION_PORT)
            .writable(&self.candidate_root)
            .writable(&self.out_dir)
            .writable(&self.cache_root)
            .writable(std::env::temp_dir());
        if let Some(bundle) = &self.installed_bundle {
            policy = policy.denied(bundle);
        }
        policy
    }

    /// The environment a worker runs in: the caller's, minus every production
    /// credential, plus caches that keep the build out of the user's own — and
    /// a `PATH` that actually has the toolchain on it.
    pub fn worker_env(&self) -> Vec<(String, String)> {
        let cache = &self.cache_root;
        vec![
            ("PATH".into(), toolchain_path()),
            ("CARGO_TARGET_DIR".into(), self.target_dir().display().to_string()),
            // The confined build signs ad-hoc. The real identity is applied
            // afterwards by the trusted controller, outside the sandbox —
            // signing must never be something a command from the candidate's
            // own source gets to choose, and reaching the keychain from inside
            // the sandbox would be a capability it has no business holding.
            ("APPLE_SIGNING_IDENTITY".into(), String::new()),
            ("CARGO_HOME".into(), cache.join("cargo").display().to_string()),
            ("npm_config_cache".into(), cache.join("npm").display().to_string()),
            ("TMPDIR".into(), cache.join("tmp").display().to_string()),
            // Never colour-code into a captured log.
            ("CI".into(), "1".into()),
            ("NO_COLOR".into(), "1".into()),
        ]
    }
}

/// A `PATH` the build can actually use.
///
/// A Finder-launched app inherits a launchd environment whose `PATH` is
/// `/usr/bin:/bin:/usr/sbin:/sbin` — no `npm`, no `node`, no `cargo`. Every
/// other place Redline shells out to a user toolchain has had to solve this;
/// preparation cannot be the one that discovers it twenty seconds into a
/// build, so the directories are resolved up front and [`toolchain_status`]
/// reports a missing one before anything starts.
///
/// Resolution is the same ladder the rest of the app uses: the well-known
/// install locations first (free), then an interactive login shell (expensive,
/// cached by `binprobe`), which is what sources the user's own rc files and
/// therefore finds an nvm or asdf install.
pub fn toolchain_path() -> String {
    let mut dirs: Vec<String> = Vec::new();
    let mut push = |dir: String| {
        if !dir.is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };
    for tool in TOOLCHAIN {
        if let Some(resolved) = resolve_tool(tool) {
            if let Some(parent) = Path::new(&resolved).parent() {
                push(parent.to_string_lossy().into_owned());
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        push(PathBuf::from(&home).join(".cargo/bin").to_string_lossy().into_owned());
    }
    for fixed in ["/opt/homebrew/bin", "/usr/local/bin"] {
        push(fixed.to_string());
    }
    for inherited in std::env::var("PATH").unwrap_or_default().split(':') {
        push(inherited.to_string());
    }
    for fallback in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        push(fallback.to_string());
    }
    dirs.join(":")
}

/// The binaries preparation cannot run without.
const TOOLCHAIN: &[&str] = &["npm", "node", "cargo"];

fn resolve_tool(name: &str) -> Option<String> {
    // The cheap locations first; a login shell only when they miss.
    if let Some(home) = std::env::var_os("HOME") {
        let cargo_bin = PathBuf::from(&home).join(".cargo/bin").join(name);
        if cargo_bin.is_file() {
            return Some(cargo_bin.to_string_lossy().into_owned());
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = PathBuf::from(dir).join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    crate::binprobe::login_shell_which(name)
}

/// Which toolchain binaries are missing, by name. Empty when preparation can
/// run.
pub fn missing_toolchain() -> Vec<&'static str> {
    TOOLCHAIN
        .iter()
        .filter(|name| resolve_tool(name).is_none())
        .copied()
        .collect()
}

fn claude_config_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".claude")
}

/// What preparation produced.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub manifest: ReleaseManifest,
    pub bundle_path: PathBuf,
    pub probe: crate::probe::ProbeReport,
}

/// How far preparation has got, for the release panel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: String,
    pub index: usize,
    pub total: usize,
    pub detail: String,
}

const OUTPUT_TAIL: usize = 8 * 1024;

fn tail(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let start = text.len() - cap;
    let boundary = text[start..]
        .find('\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    format!("…\n{}", &text[boundary..])
}

/// Run one confined step and record what happened.
///
/// Bounded, because a build step that hangs — a dependency resolver waiting on
/// a prompt, a test that deadlocks — would otherwise wedge preparation
/// forever with no way to tell it apart from a slow compile. The step gets its
/// own process group, so a timeout kills the whole tree rather than the
/// sandbox wrapper alone and leaving orphans holding the candidate.
fn run_step(
    ctx: &PrepareContext,
    step: &PipelineStep,
    policy: &crate::confine::Policy,
) -> Result<release_manifest::CheckResult, String> {
    let started = std::time::Instant::now();
    let program = PathBuf::from("/usr/bin/env");
    let args: Vec<&str> = step.argv.clone();
    let mut cmd = crate::confine::command(policy, &program, &args);
    cmd.current_dir(&ctx.candidate_root);
    // The child's environment is exactly what we computed — not "the parent's,
    // minus the ones we remembered to remove". `env_clear` makes an omission a
    // missing PATH (loud, immediate) instead of a leaked credential (silent).
    cmd.env_clear();
    let extras: Vec<(String, String)> = ctx.worker_env();
    let borrowed: Vec<(&str, &str)> = extras
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    for (key, value) in crate::confine::worker_env(&borrowed) {
        // An empty value is a removal, not a setting. `APPLE_SIGNING_IDENTITY`
        // uses it: the confined build must sign ad-hoc, and an empty-but-set
        // variable is not reliably the same thing as an absent one.
        if value.is_empty() {
            continue;
        }
        cmd.env(key, value);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{}: {e}", step.argv.join(" ")))?;
    let pid = child.id() as i32;
    // Drain both pipes on their own threads. A build that fills a pipe buffer
    // while nobody is reading blocks on write, which looks exactly like a hang
    // and is entirely our fault.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let read = |handle: Option<std::process::ChildStdout>| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = String::new();
            if let Some(mut h) = handle {
                let _ = h.read_to_string(&mut buf);
            }
            buf
        })
    };
    let out_thread = read(stdout);
    let err_thread = {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = String::new();
            if let Some(mut h) = stderr {
                let _ = h.read_to_string(&mut buf);
            }
            buf
        })
    };

    let deadline = std::time::Instant::now() + ctx.step_timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(format!("{}: {e}", step.argv.join(" "))),
        }
        if std::time::Instant::now() >= deadline {
            timed_out = true;
            #[cfg(unix)]
            unsafe {
                // The whole group: `setsid` above made this process its leader.
                libc::kill(-pid, libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    };

    let mut combined = out_thread.join().unwrap_or_default();
    combined.push_str(&err_thread.join().unwrap_or_default());
    if timed_out {
        combined.push_str(&format!(
            "\n[stopped after {}s — this step did not finish]\n",
            ctx.step_timeout.as_secs()
        ));
    }
    Ok(release_manifest::CheckResult {
        name: step.name.to_string(),
        command: step.argv.join(" "),
        exit_code: status.and_then(|s| s.code()),
        ok: status.map(|s| s.success()).unwrap_or(false),
        duration_ms: started.elapsed().as_millis() as u64,
        output: tail(&combined, OUTPUT_CAP_FOR_A_CHECK),
    })
}

/// How much of a step's output is kept. Enough to see a failing test's
/// assertion; not enough for a verbose build log to become the release record.
const OUTPUT_CAP_FOR_A_CHECK: usize = OUTPUT_TAIL;

/// Re-sign a bundle with the configured local identity.
///
/// Signing is the trusted controller's job, run outside the sandbox and never
/// from a command the candidate's own source could choose. It happens *after*
/// the helper and the identity stamp go in, because both are inside what the
/// signature covers.
///
/// Nested code first, then the bundle: a signature over a bundle whose
/// executables are signed afterwards does not verify.
pub fn sign_bundle(bundle: &Path, identity: Option<&str>, entitlements: Option<&Path>) -> Result<release_manifest::SigningInfo, String> {
    let id = identity.unwrap_or("-");
    let mut targets: Vec<PathBuf> = Vec::new();
    for nested in ["Contents/Frameworks", "Contents/MacOS", "Contents/Resources"] {
        let dir = bundle.join(nested);
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && is_macho(&path) {
                targets.push(path);
            } else if path.is_dir() && path.extension().map(|e| e == "framework" || e == "app").unwrap_or(false) {
                targets.push(path);
            }
        }
    }
    targets.push(bundle.to_path_buf());

    for (index, target) in targets.iter().enumerate() {
        let mut cmd = std::process::Command::new("/usr/bin/codesign");
        cmd.args(["--force", "--sign", id, "--timestamp=none"]);
        // Entitlements belong to the application, not to a nested helper.
        if index + 1 == targets.len() {
            if let Some(ent) = entitlements.filter(|p| p.is_file()) {
                cmd.arg("--entitlements").arg(ent);
            }
        }
        cmd.arg(target);
        let out = cmd
            .output()
            .map_err(|e| format!("codesign: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "could not sign {}: {}",
                target.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }

    let verify = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "--deep"])
        .arg(bundle)
        .output()
        .map_err(|e| format!("codesign --verify: {e}"))?;
    let describe = std::process::Command::new("/usr/bin/codesign")
        .args(["-dv"])
        .arg(bundle)
        .output()
        .map_err(|e| format!("codesign -dv: {e}"))?;
    let authority: Vec<String> = String::from_utf8_lossy(&describe.stderr)
        .lines()
        .filter(|l| l.starts_with("Authority="))
        .map(|l| l.trim_start_matches("Authority=").to_string())
        .collect();
    Ok(release_manifest::SigningInfo {
        identity: identity.map(|s| s.to_string()),
        ad_hoc: identity.is_none(),
        verified: verify.status.success(),
        authority,
    })
}

fn is_macho(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    matches!(
        u32::from_be_bytes(magic),
        0xfeed_face | 0xfeed_facf | 0xcafe_babe | 0xcffa_edfe | 0xcefa_edfe
    )
}

/// A loopback port nothing is listening on, in the range a probe is allowed to
/// use. Bound and released, so the answer is a fact rather than a guess.
pub fn free_probe_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not find a free port for the probe: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the probe port: {e}"))?
        .port();
    drop(listener);
    if port == crate::runtime_profile::PRODUCTION_PORT {
        return Err("the only free port was the production daemon's".into());
    }
    Ok(port)
}

/// Start the packaged candidate against disposable data and read what it
/// managed to do.
///
/// Confined like every other preparation process — a probe is a program the
/// candidate's own source produced, and the one thing it must not be able to
/// do is reach the installation it is a candidate to replace.
pub fn probe_candidate(
    ctx: &PrepareContext,
    bundle: &Path,
    policy: &crate::confine::Policy,
) -> Result<crate::probe::ProbeReport, String> {
    let probe_dir = ctx.out_dir.join("probe-data");
    let _ = std::fs::remove_dir_all(&probe_dir);
    std::fs::create_dir_all(&probe_dir).map_err(|e| format!("{}: {e}", probe_dir.display()))?;
    // A snapshot, so the candidate's migrations meet the shape of the user's
    // real data — and a copy, so whatever they do to it happens to nothing.
    if let Some(snapshot) = &ctx.database_snapshot {
        if snapshot.is_file() {
            std::fs::copy(snapshot, probe_dir.join("redline.db"))
                .map_err(|e| format!("could not seed the probe database: {e}"))?;
        }
    }
    let report_path = ctx.out_dir.join("probe-report.json");
    let _ = std::fs::remove_file(&report_path);
    let port = free_probe_port()?;
    let exe = bundle.join("Contents/MacOS/Redline");
    if !exe.is_file() {
        return Err(format!("the packaged candidate has no executable at {}", exe.display()));
    }

    let mut cmd = crate::confine::command(policy, &exe, &[]);
    crate::confine::strip_inherited_credentials(&mut cmd);
    cmd.env(crate::runtime_profile::ENV_PROFILE, "probe")
        .env(crate::runtime_profile::ENV_DATA_DIR, &probe_dir)
        .env(crate::runtime_profile::ENV_PORT, port.to_string())
        .env(crate::runtime_profile::ENV_PROBE_REPORT, &report_path)
        .env_remove(crate::runtime_profile::ENV_ACTIVATION_TXN)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the candidate: {e}"))?;
    let deadline = std::time::Instant::now() + ctx.probe_timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => return Err(format!("could not wait for the candidate: {e}")),
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let partial = std::fs::read(&report_path)
                .ok()
                .and_then(|b| serde_json::from_slice::<crate::probe::ProbeReport>(&b).ok());
            let reached = partial
                .map(|p| {
                    p.steps
                        .iter()
                        .map(|s| format!("{:?}", s.milestone))
                        .collect::<Vec<_>>()
                        .join(" → ")
                })
                .unwrap_or_else(|| "nothing".into());
            return Err(format!(
                "the candidate did not finish starting within {}s (it reached {reached})",
                ctx.probe_timeout.as_secs()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let bytes = std::fs::read(&report_path)
        .map_err(|_| "the candidate started but wrote no report — it exited before its first window".to_string())?;
    let report: crate::probe::ProbeReport =
        serde_json::from_slice(&bytes).map_err(|e| format!("the candidate's report was unreadable: {e}"))?;
    report.verdict()?;
    Ok(report)
}

/// Whether a release's data changes can be undone by a restart, or need
/// maintenance instead.
///
/// The question is not "does the schema change" — it is whether the release we
/// would roll back to can still read what this one writes. So it is not
/// inferred from a version number: the probe has just run the candidate's
/// migrations against a snapshot of the user's real database, and this
/// **opens that migrated file with the current build**. If it opens and passes
/// the current build's own schema check, the previous release can read the new
/// one's data. If it does not, there is no way back, and no restart is offered.
///
/// Both stores are covered, because they are versioned independently and
/// always have been: this app stamps `user_version`, and the memory store
/// keeps its own key and would not notice the other moving.
pub fn data_compatibility(
    candidate_root: &Path,
    migrated_database: Option<&Path>,
) -> release_manifest::DataCompatibility {
    let schema_version = crate::db::Database::schema_version();
    let candidate_version = read_declared_schema_version(candidate_root);
    let migrations: Vec<String> = match candidate_version {
        Some(v) if v > schema_version => ((schema_version + 1)..=v)
            .map(|step| format!("host schema v{} → v{step}", step - 1))
            .collect(),
        _ => Vec::new(),
    };
    let memory_schema = memory_store_revision(candidate_root)
        .unwrap_or_else(|| "unknown".to_string());
    // "Ours" is the checkout this binary was built from — not the process's
    // working directory, which under a Finder launch is `/`.
    let memory_changed = crate::update::repo_root()
        .and_then(|ours| memory_store_revision(&ours))
        .zip(memory_store_revision(candidate_root))
        .map(|(ours, theirs)| ours != theirs)
        .unwrap_or(false);

    let (previous_can_read, read_back) = match migrated_database {
        Some(path) if path.is_file() => match previous_release_can_read(path) {
            Ok(()) => (true, "Your previous version opened this release's database.".to_string()),
            Err(e) => (false, e),
        },
        // Nothing to read back: the probe produced no database, which is
        // itself a reason not to claim compatibility.
        _ => (
            false,
            "The candidate produced no database to check for compatibility.".to_string(),
        ),
    };

    let requires_maintenance = !previous_can_read || memory_changed;
    let notes = if !previous_can_read {
        format!("There would be no way back from this release. {read_back}")
    } else if memory_changed {
        "This release changes the memory store's own versioned storage. That is maintenance, \
         not a quick restart."
            .to_string()
    } else if migrations.is_empty() {
        "This release does not change how anything is stored.".to_string()
    } else {
        format!(
            "This release applies {} storage change{}, and your previous version can still read \
             the result.",
            migrations.len(),
            if migrations.len() == 1 { "" } else { "s" }
        )
    };

    release_manifest::DataCompatibility {
        schema_version: candidate_version.unwrap_or(schema_version),
        memory_schema,
        migrations,
        previous_can_read,
        external_state: Vec::new(),
        requires_maintenance,
        notes,
    }
}

/// Open a database the candidate has migrated, with **this** build.
///
/// This is the rollback question asked directly: after the exchange is
/// reversed, the previous release opens the file the new one left behind. A
/// copy is opened, not the original, so the check itself cannot migrate
/// anything further.
pub fn previous_release_can_read(migrated: &Path) -> Result<(), String> {
    let scratch = migrated.with_extension("readback.db");
    let _ = std::fs::remove_file(&scratch);
    std::fs::copy(migrated, &scratch)
        .map_err(|e| format!("could not copy the migrated database: {e}"))?;
    let result = crate::db::Database::open(&scratch)
        .map(|_| ())
        .map_err(|e| format!("Your previous version could not open it: {e}"));
    let _ = std::fs::remove_file(&scratch);
    for suffix in ["readback.db-wal", "readback.db-shm"] {
        let _ = std::fs::remove_file(migrated.with_extension(suffix));
    }
    result
}

/// The memory store's pinned revision, read out of a checkout's `Cargo.toml`.
/// It is versioned independently of this app's schema, so "did the memory
/// store change?" is a different question with a different answer.
fn memory_store_revision(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("src-tauri/Cargo.toml"))
        .or_else(|_| std::fs::read_to_string(root.join("Cargo.toml")))
        .ok()?;
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with("polis-store"))?;
    let marker = "rev = \"";
    let start = line.find(marker)? + marker.len();
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

/// Read `const SCHEMA_VERSION: i64 = N;` out of a candidate's `db.rs`.
///
/// Reading the source rather than asking the candidate is deliberate: this
/// decision is made *before* the candidate is ever started, and it is one of
/// the things that decides whether starting it is safe.
fn read_declared_schema_version(candidate_root: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(candidate_root.join("src-tauri/src/db.rs")).ok()?;
    let marker = "const SCHEMA_VERSION: i64 = ";
    let start = text.find(marker)? + marker.len();
    let end = text[start..].find(';')? + start;
    text[start..end].trim().parse().ok()
}


/// Prepare a candidate: dependencies, checks, build, package, sign, probe,
/// seal.
///
/// Blocking and long — minutes to tens of minutes. The caller runs it off the
/// UI thread and reports each step through `on_step`. Nothing here touches the
/// installed application: the last thing it produces is a sealed artifact
/// sitting in the candidate's output directory, and turning that into the
/// installed Redline is a separate decision the user makes later.
pub fn prepare(
    ctx: &PrepareContext,
    on_step: &dyn Fn(Progress),
) -> Result<Prepared, String> {
    // Confinement is qualified first, and its failure stops preparation. It is
    // not a warning: the steps below run dependency lifecycle scripts and
    // build scripts from the candidate's own source, and without confinement
    // those are arbitrary commands running as the user with the installed
    // application in reach.
    let qualification = crate::confine::qualification();
    if let Some(reason) = qualification.reason() {
        return Err(format!(
            "Redline will not prepare a release without operating-system confinement for the \
             build, and it could not be established on this machine: {reason}"
        ));
    }
    let policy = ctx.worker_policy();
    for dir in [&ctx.out_dir, &ctx.cache_root] {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::create_dir_all(ctx.cache_root.join("tmp"))
        .map_err(|e| format!("{}: {e}", ctx.cache_root.display()))?;

    let steps = pipeline();
    let total = steps.len() + 3; // + sign, probe, seal
    let mut checks: Vec<release_manifest::CheckResult> = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        on_step(Progress {
            step: step.name.to_string(),
            index,
            total,
            detail: step.argv.join(" "),
        });
        let result = run_step(ctx, step, &policy)?;
        let failed = !result.ok;
        let summary = result.output.clone();
        if step.is_check {
            checks.push(result);
        }
        if failed && step.required {
            return Err(format!("{} failed:\n{}", step.name, tail(&summary, 2048)));
        }
    }

    // --- the trusted part: identity, helper, signature ---------------------
    let built = ctx.built_bundle();
    if !built.is_dir() {
        return Err(format!(
            "the build finished but produced no application at {}",
            built.display()
        ));
    }
    // Move the bundle out of the build tree and into the release's own output
    // directory, so a later build in the same candidate cannot quietly replace
    // the artifact that was verified.
    let bundle = ctx.out_dir.join("Redline.app");
    let _ = std::fs::remove_dir_all(&bundle);
    let moved = std::process::Command::new("/usr/bin/ditto")
        .arg(&built)
        .arg(&bundle)
        .output()
        .map_err(|e| format!("could not collect the packaged application: {e}"))?;
    if !moved.status.success() {
        return Err(format!(
            "could not collect the packaged application: {}",
            String::from_utf8_lossy(&moved.stderr).trim()
        ));
    }
    let _ = std::fs::remove_dir_all(&built);

    let mut manifest = ReleaseManifest::new(&ctx.release_id);
    manifest.source = source_ref(
        &ctx.capture,
        ctx.plan_revisions.clone(),
        ctx.installed_release.clone(),
    );
    manifest.checks = checks;

    on_step(Progress {
        step: "Sign the application".into(),
        index: steps.len(),
        total,
        detail: ctx
            .signing_identity
            .clone()
            .unwrap_or_else(|| "ad-hoc".into()),
    });
    // The helper and the identity stamp go in BEFORE signing: both are inside
    // what the signature covers, and adding either afterwards would leave a
    // bundle that no longer verifies.
    let helper_src = ctx.built_helper();
    if !helper_src.is_file() {
        return Err(format!(
            "the build produced no activation helper at {}",
            helper_src.display()
        ));
    }
    let helper_dest = release_manifest::helper_path_in(&bundle);
    std::fs::create_dir_all(helper_dest.parent().unwrap_or(&bundle))
        .map_err(|e| format!("{e}"))?;
    std::fs::copy(&helper_src, &helper_dest)
        .map_err(|e| format!("could not place the activation helper: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&helper_dest, std::fs::Permissions::from_mode(0o755));
    }
    manifest
        .stamp()
        .write_into(&bundle)
        .map_err(|e| format!("could not stamp the application: {e}"))?;

    let entitlements = ctx.candidate_root.join("src-tauri/Entitlements.plist");
    manifest.signing = sign_bundle(
        &bundle,
        ctx.signing_identity.as_deref(),
        Some(&entitlements),
    )?;
    if !manifest.signing.verified {
        return Err("the packaged application was signed but its signature did not verify".into());
    }

    // --- start it for real -------------------------------------------------
    on_step(Progress {
        step: "Start the candidate".into(),
        index: steps.len() + 1,
        total,
        detail: "isolated data, private port, no hooks".into(),
    });
    let probe = probe_candidate(ctx, &bundle, &policy)?;

    // --- seal --------------------------------------------------------------
    on_step(Progress {
        step: "Seal the release".into(),
        index: steps.len() + 2,
        total,
        detail: String::new(),
    });
    manifest.data = data_compatibility(
        &ctx.candidate_root,
        Some(&ctx.out_dir.join("probe-data/redline.db")),
    );
    manifest.artifact = release_manifest::hash_bundle(&bundle, &[])?;
    manifest.seal();
    manifest
        .write_to(&ctx.out_dir.join("release-manifest.json"))
        .map_err(|e| format!("could not write the release manifest: {e}"))?;
    let _ = std::fs::write(
        ctx.out_dir.join("probe-report.json"),
        serde_json::to_vec_pretty(&probe).unwrap_or_default(),
    );
    // The patch the agents produced, kept for the source review that can apply
    // it back to the user's own checkout later.
    if let Ok(patch) = candidate_patch(&ctx.candidate_root) {
        let _ = std::fs::write(ctx.out_dir.join("candidate.patch"), patch);
    }

    let blockers = manifest.readiness_blockers();
    if !blockers.is_empty() {
        return Err(blockers.join("; "));
    }
    Ok(Prepared {
        manifest,
        bundle_path: bundle,
        probe,
    })
}


// ---------------------------------------------------------------------------
// The command surface
// ---------------------------------------------------------------------------

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};

/// Releases whose pipeline is running in this process, so a second click
/// cannot start a second build of the same candidate.
#[derive(Clone, Default)]
pub struct SelfDevelopState {
    preparing: Arc<Mutex<HashSet<String>>>,
}

impl SelfDevelopState {
    pub fn new() -> Self {
        Self::default()
    }
    fn claim(&self, release_id: &str) -> bool {
        self.preparing
            .lock()
            .map(|mut set| set.insert(release_id.to_string()))
            .unwrap_or(false)
    }
    fn release(&self, release_id: &str) {
        if let Ok(mut set) = self.preparing.lock() {
            set.remove(release_id);
        }
    }
    pub fn is_preparing(&self, release_id: &str) -> bool {
        self.preparing
            .lock()
            .map(|set| set.contains(release_id))
            .unwrap_or(false)
    }
}

/// Whether this copy of Redline can build its own replacement, and if not, the
/// one thing that would have to change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub available: bool,
    /// The Redline checkout this binary was built from.
    pub repository: Option<String>,
    /// The installed application this would replace.
    pub installed_bundle: Option<String>,
    pub installed_release: Option<String>,
    /// Operating-system confinement for the build was demonstrated.
    pub confinement: bool,
    pub confinement_detail: String,
    /// Reasons it is not available. Each is a sentence a person can act on.
    pub blockers: Vec<String>,
}

/// Can this copy prepare a replacement for itself?
///
/// Four things have to be true, and each failure says which. Two of them —
/// running from an installed bundle, and that bundle carrying a helper — are
/// why the feature needs one conventional installation to bootstrap: a
/// development run has nothing to replace, and a bundle built before this
/// feature existed has nobody to hand a restart to.
#[tauri::command]
pub fn self_develop_available() -> Availability {
    let mut blockers = Vec::new();
    let repository = crate::update::repo_root();
    if repository.is_none() {
        blockers.push(
            "Redline can't find the source checkout it was built from, so there is nothing to \
             build from."
                .into(),
        );
    }
    let installed = crate::activation::own_bundle();
    if installed.is_none() {
        blockers.push(
            "Redline is running from a development build rather than an installed application, \
             so there is nothing to replace."
                .into(),
        );
    }
    if let Some(bundle) = &installed {
        if !release_manifest::helper_path_in(bundle).is_file() {
            blockers.push(
                "The installed Redline predates in-place restarts, so it carries no activation \
                 helper. Install once with `npm run redline`; after that, releases can be \
                 applied by restarting."
                    .into(),
            );
        }
    }
    let missing = missing_toolchain();
    if !missing.is_empty() {
        blockers.push(format!(
            "Redline can't find {} on this machine. Preparing a release compiles the whole \
             application, so the same toolchain that `npm run redline` needs has to be \
             reachable.",
            missing.join(" or ")
        ));
    }
    let qualification = crate::confine::qualification();
    let confinement = qualification.is_available();
    let confinement_detail = match qualification {
        crate::confine::Qualification::Available { checks } => {
            format!("{} boundaries demonstrated on this machine", checks.len())
        }
        crate::confine::Qualification::Unavailable { reason } => reason.clone(),
    };
    if !confinement {
        blockers.push(format!(
            "The build cannot be confined on this machine, and Redline will not compile its own \
             replacement without that: {confinement_detail}"
        ));
    }
    Availability {
        available: blockers.is_empty(),
        repository: repository.map(|p| p.display().to_string()),
        installed_release: installed.as_deref().and_then(crate::activation::installed_release_id),
        installed_bundle: installed.map(|p| p.display().to_string()),
        confinement,
        confinement_detail,
        blockers,
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the data directory: {e}"))
}

fn db(app: &AppHandle) -> Result<std::sync::Arc<crate::db::Database>, String> {
    Ok(app
        .try_state::<crate::state::SessionStore>()
        .ok_or("the session store is not available")?
        .database())
}

/// Capture a candidate workspace and open a release record for it.
///
/// Returns as soon as the copy is made: the agents' work, and then the
/// pipeline, come afterwards. The user keeps using the installed Redline
/// throughout.
#[tauri::command(async)]
pub async fn self_develop_start(
    app: AppHandle,
    plan_session_id: Option<String>,
    run_id: Option<String>,
) -> Result<Release, String> {
    let availability = self_develop_available();
    if !availability.available {
        return Err(availability.blockers.join(" "));
    }
    let repo = crate::update::repo_root().ok_or("no source checkout")?;
    let data_dir = data_dir(&app)?;
    let release_id = new_release_id();
    let root = candidate_root(&data_dir, &release_id);
    let out = candidate_out(&data_dir, &release_id);
    std::fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;

    let capture = capture(&repo, &root)?;

    // The plan's tasks are decomposed against the CANDIDATE root, not the
    // user's checkout. That one substitution is what turns the existing native
    // runner into a self-development runner: claims, check barriers, retries
    // and independent review all work exactly as they do, and every write the
    // agents make lands in the copy.
    let (run_id, plan_revisions) = match (&plan_session_id, &run_id) {
        (Some(session_id), _) => {
            let graph = decompose_against_candidate(&app, session_id, &root).await?;
            let revision = app
                .try_state::<crate::state::SessionStore>()
                .and_then(|store| store.get(session_id))
                .and_then(|session| session.revisions.last().map(|r| r.version_number.to_string()))
                .map(|v| vec![format!("{session_id}@{v}")])
                .unwrap_or_default();
            (Some(graph.run_id), revision)
        }
        (None, existing) => (existing.clone(), Vec::new()),
    };

    let now = release_manifest::now_secs();
    let release = Release {
        release_id: release_id.clone(),
        run_id,
        repository: repo.display().to_string(),
        status: ReleaseStatus::Preparing.as_str().into(),
        candidate_root: root.display().to_string(),
        bundle_path: None,
        manifest: None,
        capture: Some(capture),
        probe: None,
        failure: String::new(),
        step: "candidate workspace captured".into(),
        created_at: now,
        updated_at: now,
    };
    if !plan_revisions.is_empty() {
        db(&app)?.set_setting(
            &plan_revisions_key(&release_id),
            &plan_revisions.join(","),
        )
        .map_err(|e| e.to_string())?;
    }
    db(&app)?.release_put(&release)?;
    let _ = app.emit("self-develop-changed", &release);
    Ok(release)
}

/// The approved plan revisions a release implements, recorded when the
/// candidate was captured so the sealed manifest can name them.
fn plan_revisions_key(release_id: &str) -> String {
    format!("redline.selfDevelop.planRevisions.{release_id}")
}

/// Decompose a plan into a run graph rooted in the candidate workspace.
async fn decompose_against_candidate(
    app: &AppHandle,
    plan_session_id: &str,
    candidate_root: &Path,
) -> Result<crate::runner_graph::RunGraph, String> {
    let store = app
        .try_state::<crate::state::SessionStore>()
        .ok_or("the session store is not available")?;
    let session = store.get(plan_session_id).ok_or("unknown plan session")?;
    let plan = session
        .revisions
        .last()
        .ok_or("that plan has no revision")?
        .raw_plan_markdown
        .clone();
    let runner = app
        .try_state::<crate::runner::RunnerState>()
        .ok_or("the runner is not available")?;
    let graph = crate::runner::decompose_plan(
        runner.db.clone(),
        plan_session_id,
        &candidate_root.to_string_lossy(),
        &plan,
    )
    .await?;
    let _ = app.emit("run-graph", &graph);
    Ok(graph)
}

#[tauri::command]
pub fn self_develop_list(app: AppHandle) -> Result<Vec<Release>, String> {
    db(&app)?.release_list(50)
}

#[tauri::command]
pub fn self_develop_get(app: AppHandle, release_id: String) -> Result<Option<Release>, String> {
    db(&app)?.release_get(&release_id)
}

/// Move a release to a new status, refusing transitions the lifecycle does not
/// allow.
fn set_status(
    app: &AppHandle,
    release: &mut Release,
    next: ReleaseStatus,
    step: &str,
) -> Result<(), String> {
    let current = release.status();
    if !current.can_move_to(next) {
        return Err(format!(
            "a release cannot go from {} to {}",
            current.as_str(),
            next.as_str()
        ));
    }
    release.status = next.as_str().to_string();
    release.step = step.to_string();
    release.updated_at = release_manifest::now_secs();
    db(app)?.release_put(release)?;
    let _ = app.emit("self-develop-changed", &*release);
    Ok(())
}

/// Run the trusted pipeline against a captured candidate.
///
/// Long and blocking, so it runs on the blocking pool and reports through
/// events. The *installed* Redline stays completely usable throughout — that
/// is the whole point, and the confinement above is what makes it true rather
/// than hopeful.
#[tauri::command(async)]
pub async fn self_develop_prepare(app: AppHandle, release_id: String) -> Result<Release, String> {
    let state = app
        .try_state::<SelfDevelopState>()
        .ok_or("self-development is not available")?
        .inner()
        .clone();
    if !state.claim(&release_id) {
        return Err("this release is already being prepared".into());
    }
    let result = prepare_inner(app.clone(), release_id.clone()).await;
    state.release(&release_id);
    match result {
        Ok(release) => Ok(release),
        Err(e) => {
            // A failure is recorded on the release, not just returned: the user
            // may not be looking at the panel when a twenty-minute build ends.
            if let Ok(Some(mut release)) = db(&app).and_then(|d| d.release_get(&release_id)) {
                release.status = ReleaseStatus::Failed.as_str().into();
                release.failure = e.clone();
                release.step = String::new();
                release.updated_at = release_manifest::now_secs();
                let _ = db(&app).and_then(|d| d.release_put(&release));
                let _ = app.emit("self-develop-changed", &release);
            }
            Err(e)
        }
    }
}

async fn prepare_inner(app: AppHandle, release_id: String) -> Result<Release, String> {
    let data_dir = data_dir(&app)?;
    let mut release = db(&app)?
        .release_get(&release_id)?
        .ok_or("no such release")?;
    if release.status().is_terminal() {
        return Err(format!(
            "this release is {} and cannot be prepared again",
            release.status().as_str()
        ));
    }
    set_status(&app, &mut release, ReleaseStatus::Verifying, "starting")?;

    // A consistent snapshot for the probe to open, taken with SQLite's backup
    // facility while the app stays live — never a copy of the live file.
    let snapshot_path = candidate_out(&data_dir, &release_id).join("live-snapshot.db");
    {
        let database = db(&app)?;
        let dest = snapshot_path.clone();
        tokio::task::spawn_blocking(move || database.snapshot_to(&dest))
            .await
            .map_err(|e| format!("the probe snapshot did not run: {e}"))?
            .map_err(|e| format!("could not snapshot the database for the probe: {e}"))?;
    }

    let installed = crate::activation::own_bundle();
    let ctx = PrepareContext {
        release_id: release_id.clone(),
        candidate_root: PathBuf::from(&release.candidate_root),
        out_dir: candidate_out(&data_dir, &release_id),
        cache_root: cache_root(&data_dir),
        data_dir: data_dir.clone(),
        installed_release: installed.as_deref().and_then(crate::activation::installed_release_id),
        installed_bundle: installed,
        signing_identity: signing_identity(),
        plan_revisions: db(&app)?
            .get_setting(&plan_revisions_key(&release_id))
            .map(|s| s.split(',').map(str::to_string).collect())
            .unwrap_or_default(),
        capture: release.capture.clone().unwrap_or_default(),
        database_snapshot: Some(snapshot_path),
        step_timeout: std::time::Duration::from_secs(60 * 60),
        probe_timeout: std::time::Duration::from_secs(180),
    };

    let progress_app = app.clone();
    let progress_id = release_id.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        prepare(&ctx, &move |progress: Progress| {
            let _ = progress_app.emit(
                "self-develop-progress",
                serde_json::json!({ "releaseId": progress_id, "progress": progress }),
            );
        })
    })
    .await
    .map_err(|e| format!("the preparation pipeline did not run: {e}"))??;

    release.manifest = Some(prepared.manifest);
    release.bundle_path = Some(prepared.bundle_path.display().to_string());
    release.probe = Some(prepared.probe);
    release.failure = String::new();
    set_status(&app, &mut release, ReleaseStatus::Ready, "ready to restart")?;
    Ok(release)
}

/// The signing identity the trusted controller uses, matching what the manual
/// installation has always done: a stable local certificate when one exists,
/// so macOS folder permissions survive a reinstall, and ad-hoc otherwise.
fn signing_identity() -> Option<String> {
    if let Ok(configured) = std::env::var("APPLE_SIGNING_IDENTITY") {
        if !configured.trim().is_empty() {
            return Some(configured);
        }
    }
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-identity", "-v", "-p", "codesigning"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .contains("\"Redline Dev\"")
        .then(|| "Redline Dev".to_string())
}

/// True while this process is running a pipeline for `release_id`.
fn preparing_now(app: &AppHandle, release_id: &str) -> bool {
    app.try_state::<SelfDevelopState>()
        .map(|state| state.is_preparing(release_id))
        .unwrap_or(false)
}

#[tauri::command]
pub fn self_develop_cancel(app: AppHandle, release_id: String) -> Result<Release, String> {
    let mut release = db(&app)?
        .release_get(&release_id)?
        .ok_or("no such release")?;
    if preparing_now(&app, &release_id) {
        return Err(
            "this release is being built right now. Wait for the build to finish, or quit \
             Redline to stop it."
                .into(),
        );
    }
    if release.status().holds_activation() {
        return Err(
            "this release is already being installed; it cannot be cancelled from here.".into(),
        );
    }
    set_status(&app, &mut release, ReleaseStatus::Cancelled, "cancelled")?;
    Ok(release)
}

/// Delete a release's workspace and output. The record stays, so the history
/// still shows what happened.
#[tauri::command(async)]
pub fn self_develop_discard(app: AppHandle, release_id: String) -> Result<(), String> {
    let data_dir = data_dir(&app)?;
    let release = db(&app)?
        .release_get(&release_id)?
        .ok_or("no such release")?;
    if release.status().holds_activation() {
        return Err("this release is being installed right now.".into());
    }
    // Deleting the workspace under a live pipeline would leave `npm ci` or a
    // linker writing into a directory that no longer exists, and the failure
    // would read as a broken build rather than as this.
    if preparing_now(&app, &release_id) {
        return Err("this release is being built right now.".into());
    }
    let _ = std::fs::remove_dir_all(data_dir.join(CANDIDATES_DIR).join(&release_id));
    db(&app)?.release_delete(&release_id)?;
    let _ = app.emit("self-develop-changed", serde_json::Value::Null);
    Ok(())
}

/// The agents' work as a reviewable patch, and whether it would still apply to
/// the user's own checkout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchView {
    pub release_id: String,
    pub patch: String,
    pub changed_files: Vec<String>,
    pub applies_cleanly: bool,
    pub repository: String,
}

#[tauri::command(async)]
pub fn self_develop_patch(app: AppHandle, release_id: String) -> Result<PatchView, String> {
    let release = db(&app)?
        .release_get(&release_id)?
        .ok_or("no such release")?;
    let root = PathBuf::from(&release.candidate_root);
    let patch = candidate_patch(&root)?;
    let changed_files = candidate_changed_files(&root)?;
    let repo = PathBuf::from(&release.repository);
    let applies_cleanly = patch_applies_cleanly(&repo, &patch).unwrap_or(false);
    Ok(PatchView {
        release_id,
        patch,
        changed_files,
        applies_cleanly,
        repository: release.repository,
    })
}

/// The sealed manifest for a release, read from the file beside its artifact.
///
/// Not the copy in the database. That copy is for the UI; this one is the
/// record that was sealed at the end of preparation, sitting next to the
/// bundle it describes, and it is what the restart path checks. A row can be
/// edited by anything that can write to the database; the seal cannot be
/// edited at all without becoming detectably broken.
fn sealed_manifest(app: &AppHandle, release: &Release) -> Result<ReleaseManifest, String> {
    let data_dir = data_dir(app)?;
    let path = candidate_out(&data_dir, &release.release_id).join("release-manifest.json");
    match ReleaseManifest::read_from(&path) {
        Ok(manifest) => Ok(manifest),
        // A release prepared before the file existed, or one whose output was
        // cleaned up: fall back to the row, which still has to pass every
        // readiness check including its own seal.
        Err(_) => release
            .manifest
            .clone()
            .ok_or_else(|| "this release has not been prepared".to_string()),
    }
}

/// Re-check everything a restart depends on, right now.
#[tauri::command(async)]
pub fn self_develop_preflight(
    app: AppHandle,
    release_id: String,
) -> Result<crate::activation::RestartPreflight, String> {
    let release = db(&app)?
        .release_get(&release_id)?
        .ok_or("no such release")?;
    let bundle = release
        .bundle_path
        .clone()
        .ok_or("this release was never packaged")?;
    let manifest = sealed_manifest(&app, &release)?;
    let installed = crate::activation::own_bundle()
        .ok_or("Redline is not running from an installed application")?;
    let mut preflight = crate::activation::preflight(
        &manifest,
        Path::new(&bundle),
        &installed,
        &data_dir(&app)?,
    );
    // One activation at a time, across this mode, the updater and the manual
    // installation script. Two exchanges racing for the same path is how one
    // release silently loses the other's features.
    if let Ok(Some(holder)) = db(&app)?.release_holding_activation() {
        if holder.release_id != release_id {
            preflight.ok = false;
            preflight.blockers.push(format!(
                "another release ({}) is being installed right now",
                holder.release_id
            ));
        }
    }
    Ok(preflight)
}

/// Save everything, hand over to the helper, and quit.
#[tauri::command(async)]
pub async fn self_develop_restart(
    app: AppHandle,
    release_id: String,
) -> Result<String, crate::activation::RestartRefused> {
    let refuse = |reason: String| crate::activation::RestartRefused {
        reason,
        blocking: Vec::new(),
        retryable: false,
    };
    let release = db(&app)
        .map_err(refuse)?
        .release_get(&release_id)
        .map_err(refuse)?
        .ok_or_else(|| refuse("no such release".into()))?;
    if !release.is_restartable() {
        return Err(refuse(
            "this release is not ready to be installed.".to_string(),
        ));
    }
    let manifest = sealed_manifest(&app, &release).map_err(refuse)?;
    let bundle = PathBuf::from(release.bundle_path.clone().unwrap_or_default());

    let mut moving = release.clone();
    if let Err(e) = set_status(
        &app,
        &mut moving,
        ReleaseStatus::Quiescing,
        "saving your work",
    ) {
        return Err(refuse(e));
    }

    match crate::activation::restart_to_apply(app.clone(), release_id.clone(), bundle, manifest)
        .await
    {
        Ok(txn) => {
            let mut activating = moving.clone();
            let _ = set_status(
                &app,
                &mut activating,
                ReleaseStatus::Activating,
                "installing the new version",
            );
            Ok(txn)
        }
        Err(refused) => {
            // Nothing was changed; the release goes back to being offered.
            let mut back = moving.clone();
            let _ = set_status(&app, &mut back, ReleaseStatus::Ready, "ready to restart");
            Err(refused)
        }
    }
}

/// What is running right now, split into what survives a restart and what does
/// not.
///
/// Read before the confirmation is shown, so "which terminals will close" is
/// the actual list rather than a generic warning.
#[tauri::command]
pub fn activation_live_work(app: AppHandle) -> crate::activation::LiveWork {
    crate::activation::live_work(&app)
}

/// The frontend's confirmation that it has flushed everything, carrying the
/// state it wants restored afterwards.
#[tauri::command]
pub fn activation_flush_complete(state: serde_json::Value) {
    crate::activation::flush_complete(state);
}

/// What the restart machinery is doing, for the banner and the release panel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivationStatus {
    /// A freshly installed release is proving itself right now.
    pub verifying: bool,
    /// Writes are being refused, and why.
    pub gated: bool,
    pub gated_message: String,
    /// The release this process is.
    pub running_release: Option<String>,
    /// What the last finished activation did.
    pub last_report: Option<crate::activation::ActivationReport>,
}

#[tauri::command]
pub fn activation_status(app: AppHandle) -> ActivationStatus {
    let last_report = db(&app)
        .ok()
        .and_then(|d| d.get_setting(crate::activation::REPORT_KEY))
        .and_then(|s| serde_json::from_str(&s).ok());
    ActivationStatus {
        verifying: crate::activation::activating(),
        gated: crate::activation::mutations_gated(),
        gated_message: crate::activation::gated_message(),
        running_release: crate::activation::own_release_id(),
        last_report,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rl-selfdev-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A checkout shaped like Redline's: tracked source, a tracked secret-ish
    /// file, local modifications, untracked source, ignored build output.
    fn fixture(dir: &Path) -> PathBuf {
        let repo = dir.join("checkout");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(repo.join(".claude")).unwrap();
        std::fs::create_dir_all(repo.join("node_modules/left-pad")).unwrap();
        std::fs::create_dir_all(repo.join("src-tauri/target/debug")).unwrap();
        std::fs::write(repo.join(".gitignore"), "node_modules/\nsrc-tauri/target/\ndist/\n").unwrap();
        std::fs::write(repo.join("src/lib.rs"), "fn main() {}\n").unwrap();
        std::fs::write(repo.join("package.json"), "{}\n").unwrap();
        std::fs::write(repo.join(".claude/settings.local.json"), "{\"hooks\":{}}").unwrap();
        // A build artifact some checkouts end up tracking. Unlike the hook
        // file above, nothing in a user's global gitignore hides it, so it is
        // the one that proves the exclusion list itself is doing work.
        std::fs::create_dir_all(repo.join("src-tauri/resources")).unwrap();
        std::fs::write(repo.join("src-tauri/resources/redline-activate"), "MACHO").unwrap();
        std::fs::write(repo.join("node_modules/left-pad/index.js"), "module.exports=1").unwrap();
        std::fs::write(repo.join("src-tauri/target/debug/redline"), "ELF").unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["add", "-A"],
            vec![
                "-c", "user.email=t@t.invalid", "-c", "user.name=t",
                "commit", "-q", "--no-gpg-sign", "-m", "base",
            ],
        ] {
            super::git(&repo, &args).unwrap();
        }
        // Now the state a real checkout is actually in.
        std::fs::write(repo.join("src/lib.rs"), "fn main() { /* edited */ }\n").unwrap();
        std::fs::write(repo.join("src/new_module.rs"), "// untracked but real\n").unwrap();
        std::fs::write(repo.join(".env"), "SECRET=hunter2\n").unwrap();
        repo
    }

    #[test]
    fn a_capture_carries_local_modifications_and_untracked_source() {
        let dir = tmp("capture");
        let repo = fixture(&dir);
        let candidate = dir.join("candidate");
        let capture = capture(&repo, &candidate).unwrap();

        // The user's edit came along, as an edit — not the committed version.
        assert_eq!(
            std::fs::read_to_string(candidate.join("src/lib.rs")).unwrap(),
            "fn main() { /* edited */ }\n"
        );
        assert!(capture.modified.contains(&"src/lib.rs".to_string()));
        // So did the untracked module.
        assert!(candidate.join("src/new_module.rs").is_file());
        assert!(capture.untracked.contains(&"src/new_module.rs".to_string()));
        assert!(!capture.fingerprint.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_capture_leaves_credentials_hooks_and_build_output_behind() {
        let dir = tmp("exclude");
        let repo = fixture(&dir);
        let candidate = dir.join("candidate");
        let capture = capture(&repo, &candidate).unwrap();
        for forbidden in [
            ".env",
            ".claude/settings.local.json",
            "node_modules/left-pad/index.js",
            "src-tauri/target/debug/redline",
            "src-tauri/resources/redline-activate",
        ] {
            assert!(
                !candidate.join(forbidden).exists(),
                "{forbidden} must not be captured"
            );
        }
        // A TRACKED file that git would happily hand over, refused by this
        // module's own list and reported as such.
        assert!(
            capture
                .excluded
                .contains(&"src-tauri/resources/redline-activate".to_string()),
            "{:?}",
            capture.excluded
        );
        // Ordinary source is still there — the exclusions are narrow.
        assert!(candidate.join("package.json").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_candidate_gets_its_own_repository_not_the_live_ones() {
        let dir = tmp("repo");
        let repo = fixture(&dir);
        let candidate = dir.join("candidate");
        capture(&repo, &candidate).unwrap();
        // Its own history, one commit deep, and the live checkout's revision
        // is not reachable from it.
        let log = super::git(&candidate, &["log", "--oneline"]).unwrap();
        assert_eq!(log.lines().count(), 1, "{log}");
        let live_head = super::git(&repo, &["rev-parse", "HEAD"]).unwrap();
        let candidate_head = super::git(&candidate, &["rev-parse", "HEAD"]).unwrap();
        assert_ne!(live_head, candidate_head);
        // And the baseline is clean: an agent's edit is the only thing a diff
        // will ever show.
        assert!(super::git(&candidate, &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_edits_are_attributable_against_the_captured_baseline() {
        let dir = tmp("patch");
        let repo = fixture(&dir);
        let candidate = dir.join("candidate");
        capture(&repo, &candidate).unwrap();
        assert!(candidate_patch(&candidate).unwrap().trim().is_empty());

        // An agent edits an existing file and adds a new one.
        std::fs::write(candidate.join("src/lib.rs"), "fn main() { agent(); }\n").unwrap();
        std::fs::write(candidate.join("src/agent_added.rs"), "// new\n").unwrap();
        let changed = candidate_changed_files(&candidate).unwrap();
        assert!(changed.contains(&"src/lib.rs".to_string()));
        assert!(
            changed.contains(&"src/agent_added.rs".to_string()),
            "a new file must appear in the patch, not vanish: {changed:?}"
        );
        let patch = candidate_patch(&candidate).unwrap();
        assert!(patch.contains("agent()"));
        assert!(patch.contains("agent_added.rs"));
        // The user's own checkout is untouched by all of it.
        assert_eq!(
            std::fs::read_to_string(repo.join("src/lib.rs")).unwrap(),
            "fn main() { /* edited */ }\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_patch_that_would_conflict_is_detected_before_it_is_offered() {
        let dir = tmp("conflict");
        let repo = fixture(&dir);
        let candidate = dir.join("candidate");
        capture(&repo, &candidate).unwrap();
        std::fs::write(candidate.join("src/lib.rs"), "fn main() { agent(); }\n").unwrap();
        let patch = candidate_patch(&candidate).unwrap();
        assert!(patch_applies_cleanly(&repo, &patch).unwrap());
        // The user kept working while preparation ran.
        std::fs::write(repo.join("src/lib.rs"), "fn main() { human(); }\n").unwrap();
        assert!(!patch_applies_cleanly(&repo, &patch).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_capture_of_unchanged_source_has_the_same_fingerprint() {
        let dir = tmp("stable");
        let repo = fixture(&dir);
        let a = capture(&repo, &dir.join("a")).unwrap();
        let b = capture(&repo, &dir.join("b")).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        // ...and a one-character edit changes it.
        std::fs::write(repo.join("src/lib.rs"), "fn main() { /* edited! */ }\n").unwrap();
        assert_ne!(capture(&repo, &dir.join("c")).unwrap().fingerprint, a.fingerprint);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_worker_path_carries_the_toolchain_and_not_a_launchd_stub() {
        // A Finder-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin`.
        // Preparation compiles the whole application; handing a build that
        // PATH fails twenty seconds in with "npm: command not found".
        let path = toolchain_path();
        assert!(path.contains("/usr/bin"), "{path}");
        let dirs: Vec<&str> = path.split(':').collect();
        // No duplicates: the ladder appends, and a PATH that repeats an entry
        // is a PATH that was built by accident.
        let mut seen = std::collections::HashSet::new();
        for dir in &dirs {
            assert!(seen.insert(*dir), "{dir} appears twice in {path}");
        }
        // Every tool preparation needs resolves to a directory ON that PATH —
        // which is the property that matters, not which directory it is.
        for tool in TOOLCHAIN {
            if let Some(resolved) = resolve_tool(tool) {
                let parent = std::path::Path::new(&resolved)
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                assert!(dirs.contains(&parent.as_str()), "{tool} at {resolved} is not on {path}");
            }
        }
    }

    #[test]
    fn a_second_click_cannot_start_a_second_build_of_the_same_candidate() {
        // Preparing a release takes tens of minutes and writes into one
        // workspace. Two pipelines in it at once would interleave a `cargo
        // build` with an `npm ci` over the same tree and produce an artifact
        // that is neither.
        let state = SelfDevelopState::new();
        assert!(state.claim("rel-1"));
        assert!(state.is_preparing("rel-1"));
        assert!(!state.claim("rel-1"), "a second claim must be refused");
        // A different candidate is unaffected — they have separate workspaces.
        assert!(state.claim("rel-2"));
        state.release("rel-1");
        assert!(!state.is_preparing("rel-1"));
        assert!(state.claim("rel-1"), "claimable again once it has finished");
        assert!(state.is_preparing("rel-2"), "the other one is still running");
    }

    #[test]
    fn the_lifecycle_cannot_reach_ready_out_of_a_failure() {
        use ReleaseStatus::*;
        assert!(Preparing.can_move_to(Verifying));
        assert!(Verifying.can_move_to(Ready));
        assert!(Ready.can_move_to(Quiescing));
        assert!(Quiescing.can_move_to(Activating));
        assert!(Activating.can_move_to(CheckingStartup));
        assert!(CheckingStartup.can_move_to(Active));
        // The shapes that must never happen.
        assert!(!Failed.can_move_to(Ready));
        assert!(!Cancelled.can_move_to(Ready));
        assert!(!Preparing.can_move_to(Ready), "packaging cannot be skipped");
        assert!(!Ready.can_move_to(Active), "a restart cannot be skipped");
        assert!(!Active.can_move_to(Ready));
        // A failed startup goes back, never forward.
        assert!(CheckingStartup.can_move_to(RolledBack));
        assert!(!RolledBack.can_move_to(Active));
    }

    #[test]
    fn a_release_is_restartable_only_when_everything_holds() {
        let mut manifest = ReleaseManifest::new("rel-1");
        manifest.artifact.file_count = 1;
        manifest.signing.verified = true;
        manifest.data.previous_can_read = true;
        manifest.seal();
        let mut release = Release {
            release_id: "rel-1".into(),
            run_id: None,
            repository: "/repo".into(),
            status: ReleaseStatus::Ready.as_str().into(),
            candidate_root: "/candidate".into(),
            bundle_path: Some("/candidate/Redline.app".into()),
            manifest: Some(manifest),
            capture: None,
            probe: None,
            failure: String::new(),
            step: String::new(),
            created_at: 0,
            updated_at: 0,
        };
        assert!(release.is_restartable());
        // Ready, but never packaged.
        release.bundle_path = None;
        assert!(!release.is_restartable());
        release.bundle_path = Some("/candidate/Redline.app".into());
        // Ready, but the manifest no longer passes.
        release.manifest.as_mut().unwrap().data.requires_maintenance = true;
        assert!(!release.is_restartable());
    }

    #[test]
    fn credentials_are_recognised_by_shape_not_by_a_fixed_list() {
        for name in [
            ".env",
            ".env.local",
            "config/.env.production",
            "daemon.token",
            "certs/server.pem",
            "certs/server.key",
            "dev.p12",
            "keys/id_rsa",
            "keys/id_ed25519.pub",
        ] {
            assert!(is_credential(name), "{name} must never be captured");
        }
        for name in ["src/environment.rs", "docs/env.md", "tokenizer.ts"] {
            assert!(!is_credential(name), "{name} is ordinary source");
        }
    }
}

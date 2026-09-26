// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What a candidate build managed to do when it was actually started.
//!
//! A candidate that compiles, packages and signs is still only a plausible
//! release. The failures that matter to a restart — a panic before the first
//! window, a migration that will not apply, a daemon that cannot bind, a
//! frontend that renders an error boundary — all happen at runtime, and none
//! of them show up in a build log.
//!
//! So the preparer launches the packaged candidate under
//! [`crate::runtime_profile::ProfileKind::Probe`] and reads this report
//! afterwards. Everything here is written by the candidate about itself; the
//! preparer's judgement is made entirely from the file.
//!
//! The probe verifies its own isolation as it goes. It records the data
//! directory and port it was actually given, so a report that claims a healthy
//! boot *on the production port* is a failed probe, not a passed one.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::runtime_profile;

/// The stages a probe reports. Ordered as they happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Milestone {
    /// The process started and resolved a probe profile.
    Started,
    /// The database opened and any migration completed — against the
    /// disposable snapshot, never the user's file.
    Database,
    /// The daemon bound its private port.
    Daemon,
    /// The frontend rendered and completed a round trip to the backend.
    Frontend,
    /// Representative plan and run reads returned.
    Reads,
    /// The process shut down cleanly on request.
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub milestone: Milestone,
    /// Milliseconds since the probe started. These are what the restart
    /// estimate is built from — a measured number, not a guess.
    pub at_ms: u64,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// The profile the candidate resolved. Recorded so the preparer can see
    /// that the isolation it asked for is the isolation the candidate used.
    pub profile: String,
    pub data_dir: String,
    pub daemon_addr: String,
    pub steps: Vec<Step>,
    /// Every milestone was reached and none failed.
    pub ok: bool,
    /// Why not, if not.
    pub failure: String,
    /// Wall-clock from process start to the frontend being interactive. The
    /// restart estimate the user is shown comes from here.
    pub interactive_ms: u64,
}

impl ProbeReport {
    pub fn reached(&self, milestone: Milestone) -> bool {
        self.steps.iter().any(|s| s.milestone == milestone)
    }

    /// The milestones a candidate must reach before it may be offered as a
    /// restart.
    pub const REQUIRED: [Milestone; 5] = [
        Milestone::Started,
        Milestone::Database,
        Milestone::Daemon,
        Milestone::Frontend,
        Milestone::Reads,
    ];

    /// Judge a report. Separate from producing one, so the preparer's decision
    /// is testable without launching anything.
    pub fn verdict(&self) -> Result<(), String> {
        if !self.failure.is_empty() {
            return Err(self.failure.clone());
        }
        for milestone in Self::REQUIRED {
            if !self.reached(milestone) {
                return Err(format!(
                    "the candidate started but never reached {milestone:?}"
                ));
            }
        }
        if !self.reached(Milestone::Shutdown) {
            return Err("the candidate did not shut down cleanly".into());
        }
        // The isolation is part of the verdict. A candidate that bound the
        // production daemon did not prove it works — it proved the probe
        // leaked, and accepting that report would mean the user's running
        // Redline was answering for it.
        if self.daemon_addr == runtime_profile::PRODUCTION_ADDR {
            return Err(
                "the candidate bound the production daemon's port, so the probe was not isolated"
                    .into(),
            );
        }
        Ok(())
    }
}

struct State {
    started: Instant,
    report: ProbeReport,
    path: PathBuf,
}

fn state() -> Option<&'static Mutex<State>> {
    static S: OnceLock<Option<Mutex<State>>> = OnceLock::new();
    S.get_or_init(|| {
        let profile = runtime_profile::current();
        let path = profile.probe_report()?.to_path_buf();
        Some(Mutex::new(State {
            started: Instant::now(),
            report: ProbeReport {
                profile: profile.describe(),
                data_dir: profile
                    .data_dir_override()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default(),
                daemon_addr: profile.daemon_addr().to_string(),
                ..Default::default()
            },
            path,
        }))
    })
    .as_ref()
}

fn flush(state: &State) {
    if let Some(parent) = state.path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        &state.path,
        serde_json::to_vec_pretty(&state.report).unwrap_or_default(),
    );
}

/// Record a milestone. A no-op outside a probe, which is every ordinary
/// launch.
pub fn record(milestone: Milestone, detail: impl Into<String>) {
    let Some(cell) = state() else { return };
    let mut state = cell.lock().unwrap_or_else(|e| e.into_inner());
    let at_ms = state.started.elapsed().as_millis() as u64;
    if milestone == Milestone::Frontend {
        state.report.interactive_ms = at_ms;
    }
    state.report.steps.push(Step {
        milestone,
        at_ms,
        detail: detail.into(),
    });
    flush(&state);
}

/// Record that the probe failed, and why. Written immediately: the next thing
/// that happens may be the process dying.
pub fn record_failure(detail: impl Into<String>) {
    let Some(cell) = state() else { return };
    let mut state = cell.lock().unwrap_or_else(|e| e.into_inner());
    state.report.failure = detail.into();
    state.report.ok = false;
    flush(&state);
}

pub fn probing() -> bool {
    runtime_profile::current().is_probe()
}

/// The last thing a probe does: representative reads, then a clean shutdown.
///
/// Called from the window reveal, because the reveal is the first moment the
/// candidate has demonstrably done everything a launch has to do. A probe that
/// gets here and exits zero is a candidate that boots.
pub fn finish_if_probing(app: tauri::AppHandle) {
    if !probing() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Give the daemon's bind a moment to resolve; it races the reveal.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let read = representative_reads(&app);
        match read {
            Ok(detail) => record(Milestone::Reads, detail),
            Err(e) => {
                record_failure(format!("representative reads failed: {e}"));
                request_exit(&app, 1);
                return;
            }
        }
        record(Milestone::Shutdown, "exiting on request");
        if let Some(cell) = state() {
            let mut state = cell.lock().unwrap_or_else(|e| e.into_inner());
            state.report.ok = state.report.failure.is_empty();
            flush(&state);
        }
        request_exit(&app, 0);
    });
}

/// Reads that exercise the paths a user's first minute would: the plan list
/// and the run graphs, both of which go through the same storage a migration
/// would have touched.
fn representative_reads(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let store = app
        .try_state::<crate::state::SessionStore>()
        .ok_or("the session store was never registered")?;
    let sessions = store.list();
    let db = store.database();
    let runs = db.runner_list()?;
    let settings = db.get_setting("redline.ui.theme");
    Ok(format!(
        "{} plan sessions, {} runs, settings readable: {}",
        sessions.len(),
        runs.len(),
        settings.is_some()
    ))
}

fn request_exit(app: &tauri::AppHandle, code: i32) {
    // `exit` runs Tauri's normal teardown, which is what makes "shut down
    // cleanly" a real claim rather than a description of `_exit`.
    app.exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(steps: &[Milestone], addr: &str) -> ProbeReport {
        ProbeReport {
            profile: "probe".into(),
            data_dir: "/tmp/probe".into(),
            daemon_addr: addr.into(),
            steps: steps
                .iter()
                .enumerate()
                .map(|(i, m)| Step {
                    milestone: *m,
                    at_ms: i as u64 * 100,
                    detail: String::new(),
                })
                .collect(),
            ok: true,
            failure: String::new(),
            interactive_ms: 400,
        }
    }

    const ALL: [Milestone; 6] = [
        Milestone::Started,
        Milestone::Database,
        Milestone::Daemon,
        Milestone::Frontend,
        Milestone::Reads,
        Milestone::Shutdown,
    ];

    #[test]
    fn a_complete_probe_passes() {
        assert!(report(&ALL, "127.0.0.1:51234").verdict().is_ok());
    }

    #[test]
    fn every_missing_milestone_is_named() {
        for skip in ProbeReport::REQUIRED {
            let steps: Vec<Milestone> = ALL.into_iter().filter(|m| *m != skip).collect();
            let err = report(&steps, "127.0.0.1:51234").verdict().unwrap_err();
            assert!(err.contains(&format!("{skip:?}")), "{skip:?}: {err}");
        }
    }

    #[test]
    fn a_candidate_that_never_shut_down_cleanly_fails() {
        let steps: Vec<Milestone> = ALL
            .into_iter()
            .filter(|m| *m != Milestone::Shutdown)
            .collect();
        assert!(report(&steps, "127.0.0.1:51234")
            .verdict()
            .unwrap_err()
            .contains("shut down cleanly"));
    }

    #[test]
    fn a_probe_that_bound_the_production_port_is_a_failure_not_a_pass() {
        // The dangerous shape: everything green, because the running Redline
        // was the one answering.
        let err = report(&ALL, runtime_profile::PRODUCTION_ADDR)
            .verdict()
            .unwrap_err();
        assert!(err.contains("not isolated"), "{err}");
    }

    #[test]
    fn a_recorded_failure_beats_a_full_set_of_milestones() {
        let mut r = report(&ALL, "127.0.0.1:51234");
        r.failure = "database: disk image is malformed".into();
        assert_eq!(
            r.verdict().unwrap_err(),
            "database: disk image is malformed"
        );
    }

    #[test]
    fn the_report_round_trips_through_json() {
        let r = report(&ALL, "127.0.0.1:51234");
        let text = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<ProbeReport>(&text).unwrap(), r);
    }
}

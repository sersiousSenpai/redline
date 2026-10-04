// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Redline's activation helper.
//!
//! Usage:
//!
//! * `redline-activate <transaction-directory>` — finish an activation Redline
//!   handed over as it quit.
//! * `redline-activate install <prepared.app> <installed.app>` — replace an
//!   installed application with a prepared one, atomically. This is what the
//!   manual installation script calls, so that path stops having a window in
//!   which the old application has been deleted and the new one is not there
//!   yet.
//!
//! Redline cannot finish its own replacement: the process that has to be gone
//! before the bundle can be exchanged is the process that would be doing the
//! exchanging. So it hands the transaction to this executable and exits. From
//! here on, everything that happens to the user's installation happens in a
//! process that has nothing to lose by the outcome.
//!
//! It runs from a **copy outside either bundle**. The incumbent release's
//! helper is the one that drives the activation, and it is copied out of the
//! installed bundle before the exchange, so a candidate can never replace the
//! implementation that is supervising its own installation.
//!
//! What it deliberately cannot do: run an agent, compile anything, resolve a
//! dependency, or execute a command that came from a plan. It installs one
//! already-verified artifact and watches what happens.

use std::io::Write;
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use redline_activation::{
    app_has_exited, swap_paths, Handshake, Journal, Outcome, Stage, Step, Transaction,
    HELPER_LOG_FILE,
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("install") {
        std::process::exit(install_mode(&args[1..]));
    }
    let Some(dir) = args.into_iter().next() else {
        eprintln!("usage: redline-activate <transaction-directory>");
        eprintln!("       redline-activate install <prepared.app> <installed.app>");
        std::process::exit(2);
    };
    let dir = Path::new(&dir).to_path_buf();
    let txn = match Transaction::read_from(&dir) {
        Ok(txn) => txn,
        Err(e) => {
            eprintln!("redline-activate: {e}");
            std::process::exit(2);
        }
    };
    let journal = match Journal::open(&dir) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("redline-activate: cannot open the activation journal: {e}");
            std::process::exit(2);
        }
    };
    // Tell the application it may exit: from here the transaction is ours to
    // finish, whatever happens to the process that handed it over.
    if let Err(e) = std::fs::write(dir.join(redline_activation::HELPER_READY_FILE), b"1") {
        eprintln!("redline-activate: cannot signal readiness: {e}");
        std::process::exit(2);
    }
    redline_activation::fsync_dir(&dir);

    let mut helper = Helper { dir, txn, journal };
    let code = helper.run();
    std::process::exit(code);
}

struct Helper {
    dir: std::path::PathBuf,
    txn: Transaction,
    journal: Journal,
}

impl Helper {
    fn log(&self, line: &str) {
        let stamped = format!("[{}] {line}\n", redline_activation::now_secs());
        eprint!("{stamped}");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(HELPER_LOG_FILE))
        {
            let _ = f.write_all(stamped.as_bytes());
        }
    }

    fn record(&self, step: Step, detail: impl Into<String>) {
        let detail = detail.into();
        self.log(&format!("{step:?} {detail}"));
        if let Err(e) = self.journal.append(step, detail) {
            self.log(&format!("could not record {step:?}: {e}"));
        }
    }

    fn run(&mut self) -> i32 {
        // 1. The old process must actually be gone. Its advisory lock answers
        //    that without depending on a pid that may have been reused.
        if !self.wait_for_exit() {
            self.finish(
                false,
                false,
                format!(
                    "Redline was still running {} seconds after it said it was quitting, so \
                     nothing was changed. Your installed version is untouched.",
                    self.txn.exit_timeout_secs
                ),
                None,
            );
            return 1;
        }
        self.record(Step::OldExited, "");

        // 2. Both paths have to be there. A missing staged copy after the
        //    application has already quit is a refusal, not an attempt.
        if !self.txn.staged_path.exists() {
            self.finish(
                false,
                false,
                format!(
                    "The prepared application was not at {} when it was time to install it.",
                    self.txn.staged_path.display()
                ),
                None,
            );
            return 1;
        }
        if !self.txn.installed_path.exists() {
            self.finish(
                false,
                false,
                format!(
                    "There was no installed application at {}.",
                    self.txn.installed_path.display()
                ),
                None,
            );
            return 1;
        }

        // 3. The exchange, under the installation lock — the same one the
        //    manual installation script and the updater take. Two exchanges
        //    racing for the same path is how one release loses the other's
        //    features.
        let _lock = match self
            .txn
            .installed_path
            .parent()
            .ok_or_else(|| "the installed application has no parent directory".to_string())
            .and_then(|dir| {
                redline_activation::InstallLock::acquire(dir, Duration::from_secs(60))
            }) {
            Ok(lock) => lock,
            Err(e) => {
                self.finish(false, false, format!("{e} Nothing was changed."), None);
                return 1;
            }
        };
        // Intent first, then the operation, then completion — a crash between
        // them is resolved later by reading the bundle.
        self.record(Step::SwapBegin, format!("{} <-> {}", self.txn.installed_path.display(), self.txn.staged_path.display()));
        if let Err(e) = swap_paths(&self.txn.installed_path, &self.txn.staged_path) {
            self.finish(
                false,
                false,
                format!("The installed application could not be exchanged: {e}"),
                None,
            );
            return 1;
        }
        self.record(Step::SwapDone, "");

        // 4. Start what we just installed, and watch it.
        let child = match self.launch(&self.txn.installed_executable(), true) {
            Ok(child) => child,
            Err(e) => {
                self.log(&format!("the new release could not be started: {e}"));
                return self.roll_back(format!("The new version could not be started: {e}"), None);
            }
        };
        self.record(Step::Launched, format!("pid {}", child.id()));
        match self.await_health(child) {
            Ok(()) => {
                self.record(Step::HandshakeHealthy, "");
                self.finish(true, false, String::new(), Some(Stage::Healthy));
                0
            }
            Err(failure) => {
                self.record(Step::HandshakeFailed, failure.message.clone());
                self.roll_back(failure.message, failure.stage)
            }
        }
    }

    /// Block until nothing holds the application's exit lock.
    fn wait_for_exit(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(self.txn.exit_timeout_secs);
        loop {
            if app_has_exited(&self.dir) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Start a bundle's executable, detached from this helper's session so it
    /// outlives us.
    fn launch(&self, exe: &Path, with_handshake: bool) -> std::io::Result<Child> {
        let mut cmd = Command::new(exe);
        if with_handshake {
            cmd.env(
                redline_activation_env::ACTIVATION_TXN,
                self.dir.as_os_str(),
            );
        } else {
            cmd.env_remove(redline_activation_env::ACTIVATION_TXN);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // A new session: the application must not die with this helper, and
        // must not inherit its controlling terminal.
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn()
    }

    /// Wait for the handshake to reach [`Stage::Healthy`].
    ///
    /// Two separate deadlines, because they fail differently: a launch that
    /// never reaches the workspace is a broken build, and a process that
    /// reaches it and then stops answering is a build that crashes once the
    /// user touches it. Both must roll back; only the message differs.
    fn await_health(&self, mut child: Child) -> Result<(), LaunchFailure> {
        let launch_deadline = Instant::now() + Duration::from_secs(self.txn.launch_timeout_secs);
        let mut best: Option<Stage> = None;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(LaunchFailure {
                    message: format!(
                        "The new version exited during startup ({status}) without completing \
                         its checks."
                    ),
                    stage: best,
                });
            }
            let report = Handshake::read_for(&self.dir, &self.txn.txn_id, &self.txn.release_id);
            if let Some(report) = &report {
                if best.map_or(true, |b| report.stage > b) {
                    best = Some(report.stage);
                    self.log(&format!("handshake: {:?} {}", report.stage, report.detail));
                }
                if report.stage.is_failure() {
                    let _ = child.kill();
                    return Err(LaunchFailure {
                        message: format!("The new version reported a startup failure: {}", report.detail),
                        stage: best,
                    });
                }
                if report.stage == Stage::Healthy {
                    return Ok(());
                }
            }
            if Instant::now() >= launch_deadline {
                let reached = best
                    .map(|s| format!("{s:?}"))
                    .unwrap_or_else(|| "nothing".to_string());
                let _ = child.kill();
                let _ = child.wait();
                return Err(LaunchFailure {
                    message: format!(
                        "The new version did not finish starting within {} seconds (it reached {reached}).",
                        self.txn.launch_timeout_secs
                    ),
                    stage: best,
                });
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Put the previous release back and start it.
    fn roll_back(&self, why: String, stage: Option<Stage>) -> i32 {
        self.record(Step::RollbackBegin, why.clone());
        // The previous bundle is at the staged path — the exchange left it
        // there — so undoing the activation is the same operation again.
        if let Err(e) = swap_paths(&self.txn.installed_path, &self.txn.staged_path) {
            self.record(Step::Failed, format!("rollback exchange failed: {e}"));
            self.finish(
                false,
                false,
                format!(
                    "{why}\n\nRedline then could not restore your previous version \
                     automatically ({e}). Your previous version is at {}; the version that \
                     failed is installed at {}.",
                    self.txn.staged_path.display(),
                    self.txn.installed_path.display()
                ),
                stage,
            );
            return 2;
        }
        self.record(Step::RollbackSwapDone, "");
        // Start the restored release *without* a handshake: it is not being
        // activated, and a relaunch that re-entered activation is how an
        // automatic update turns into a boot loop.
        match self.launch(&self.txn.installed_executable(), false) {
            Ok(child) => self.log(&format!("previous release relaunched as pid {}", child.id())),
            Err(e) => self.log(&format!("could not relaunch the previous release: {e}")),
        }
        self.record(Step::RolledBack, "");
        self.finish(false, true, why, stage);
        1
    }

    fn finish(&self, accepted: bool, rolled_back: bool, failure: String, last_stage: Option<Stage>) {
        if accepted {
            self.record(Step::Accepted, "");
        } else if !rolled_back {
            self.record(Step::Failed, failure.clone());
        }
        let outcome = Outcome {
            txn_id: self.txn.txn_id.clone(),
            release_id: self.txn.release_id.clone(),
            accepted,
            rolled_back,
            finished_at: redline_activation::now_secs(),
            failure,
            last_stage,
        };
        if let Err(e) = outcome.write_to(&self.dir) {
            self.log(&format!("could not write the outcome: {e}"));
        }
    }
}

struct LaunchFailure {
    message: String,
    stage: Option<Stage>,
}

/// The one environment variable the helper sets. Spelled here rather than
/// imported from the application, which this executable deliberately does not
/// link; a test in the application pins the two spellings together.
mod redline_activation_env {
    pub const ACTIVATION_TXN: &str = "REDLINE_ACTIVATION_TXN";
}

/// `redline-activate install <prepared.app> <installed.app>`
///
/// Copy the prepared application next to the installed one, on the same
/// filesystem, and exchange them. What the old script did — `rm -rf` the
/// installed bundle and then copy — has a window in which the machine has no
/// Redline at all, and a failure in that window leaves nothing to go back to.
///
/// The exchange has no such window, and the previous bundle survives it: after
/// a successful launch it is removed, and if anything goes wrong it is one
/// rename away from being the installed application again.
fn install_mode(args: &[String]) -> i32 {
    let (Some(source), Some(dest)) = (args.first(), args.get(1)) else {
        eprintln!("usage: redline-activate install <prepared.app> <installed.app>");
        return 2;
    };
    let source = Path::new(source);
    let dest = Path::new(dest);
    if !source.is_dir() {
        eprintln!("redline-activate: {} is not an application bundle", source.display());
        return 1;
    }
    let Some(parent) = dest.parent() else {
        eprintln!("redline-activate: {} has no parent directory", dest.display());
        return 1;
    };
    // One installer at a time, across this, the in-app restart and the updater.
    let _lock = match redline_activation::InstallLock::acquire(parent, Duration::from_secs(60)) {
        Ok(lock) => lock,
        Err(e) => {
            eprintln!("redline-activate: {e}");
            return 1;
        }
    };
    if let Err(e) = redline_activation::swap_supported(parent) {
        eprintln!("redline-activate: {e}");
        return 1;
    }

    let staging = parent.join(format!(".redline-install-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(e) = std::fs::create_dir_all(&staging) {
        eprintln!("redline-activate: {}: {e}", staging.display());
        return 1;
    }
    let cleanup = |path: &Path| {
        let _ = std::fs::remove_dir_all(path);
    };
    let Some(name) = dest.file_name() else {
        cleanup(&staging);
        eprintln!("redline-activate: {} has no name", dest.display());
        return 1;
    };
    let staged = staging.join(name);
    // `ditto` preserves the extended attributes a code signature is made of; a
    // plain recursive copy drops them and produces a bundle that will not
    // launch, with no obvious cause.
    match Command::new("/usr/bin/ditto").arg(source).arg(&staged).output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            cleanup(&staging);
            eprintln!(
                "redline-activate: could not copy the prepared application: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
            return 1;
        }
        Err(e) => {
            cleanup(&staging);
            eprintln!("redline-activate: could not copy the prepared application: {e}");
            return 1;
        }
    }

    if dest.exists() {
        if let Err(e) = swap_paths(dest, &staged) {
            cleanup(&staging);
            eprintln!("redline-activate: could not exchange the application: {e}");
            return 1;
        }
        // `staged` now holds the PREVIOUS bundle. Removing it is the last step,
        // after the new one is already in place — so the failure mode of this
        // line is a leftover directory, never a missing application.
        cleanup(&staging);
    } else {
        if let Err(e) = std::fs::rename(&staged, dest) {
            cleanup(&staging);
            eprintln!("redline-activate: could not install the application: {e}");
            return 1;
        }
        cleanup(&staging);
    }
    redline_activation::fsync_dir(parent);
    println!("{}", dest.display());
    0
}

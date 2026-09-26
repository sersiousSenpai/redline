// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Operating-system confinement for the processes that prepare a candidate
//! build of Redline.
//!
//! A separate directory stops an agent from *typing* a path into the live
//! checkout. It does nothing about the rest of preparation: `npm ci` runs
//! lifecycle scripts, a `build.rs` is arbitrary code, and the candidate itself
//! is a program we are about to execute. Any one of them could delete the
//! installed bundle, read the user's live database, rewrite the real hook
//! configuration, or drive the running Redline — which is the process
//! supervising the whole thing.
//!
//! So preparation runs under `sandbox-exec`, deny-write by default, with the
//! candidate source and a named set of caches carved back out.
//!
//! **The adapter is qualified, not assumed.** `sandbox-exec`'s underlying
//! interfaces are deprecated, and the profile language does not behave the way
//! its documentation suggests — three rules that read as though they should
//! work are silently no-ops on macOS 14 (see [`qualify`]). Availability of the
//! binary therefore proves nothing. [`qualify`] *demonstrates* each guarantee
//! on this machine, against live files, a live listener and a live process,
//! before any preparation is allowed to start. If a demonstration fails,
//! preparation stops with the reason. It never falls back to running
//! unconfined.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// The adapter binary. Absolute: a PATH lookup is exactly the kind of thing a
/// confinement decision must not depend on.
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Binaries that exist to drive *other* applications. macOS 14 ignores both
/// `(deny appleevent-send)` and a `mach-lookup` denial of the AppleEvents
/// service — verified, not assumed — so refusing to execute the automation
/// tools at all is the mechanism that actually holds. Combined with the signal
/// denial below, a confined worker has no supported route to the running
/// Redline.
const AUTOMATION_BINARIES: &[&str] = &[
    "/usr/bin/osascript",
    "/usr/bin/automator",
    "/usr/bin/open",
    "/usr/bin/killall",
    "/usr/bin/pkill",
    "/System/Library/CoreServices/Applications/Screen Sharing.app",
];

/// What one confined process may touch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Policy {
    /// Roots the worker may write inside: the candidate source, its scratch
    /// space, and the designated dependency caches.
    pub writable: Vec<PathBuf>,
    /// Roots the worker may neither read nor write: the installed bundle, the
    /// live application data directory, the real hook configuration.
    pub denied: Vec<PathBuf>,
    /// Loopback ports the worker may not reach — the production daemon's.
    pub denied_ports: Vec<u16>,
}

impl Policy {
    pub fn writable(mut self, path: impl Into<PathBuf>) -> Self {
        self.writable.push(path.into());
        self
    }
    pub fn denied(mut self, path: impl Into<PathBuf>) -> Self {
        self.denied.push(path.into());
        self
    }
    pub fn denied_port(mut self, port: u16) -> Self {
        self.denied_ports.push(port);
        self
    }
}

/// Resolve every symlink the sandbox will resolve.
///
/// The sandbox matches on *real* paths. `/var/folders/...` — where every
/// `TMPDIR` lives — is a symlink to `/private/var/folders/...`, so a policy
/// written in the unresolved form matches nothing at all: the allow silently
/// fails open into a denial, and, far worse, a *deny* silently fails open into
/// permission. Verified on macOS 14.3, and the reason this function exists.
///
/// Canonicalizes the deepest existing ancestor and re-appends the rest, so a
/// path that does not exist yet (a candidate root about to be created, a
/// bundle about to be staged) still resolves correctly.
pub fn real_path(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    let mut tail = Vec::new();
    let mut cursor = path;
    while let Some(parent) = cursor.parent() {
        let Some(name) = cursor.file_name() else { break };
        tail.push(name.to_os_string());
        if let Ok(real) = parent.canonicalize() {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        cursor = parent;
    }
    path.to_path_buf()
}

/// Escape a path for an SBPL string literal.
fn sbpl_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for ch in raw.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

/// Render the policy as a sandbox profile.
///
/// Rules are evaluated in order and the **last match wins** (verified), which
/// is what lets a broad `deny` be carved back open by a narrow `allow` below
/// it. Reads stay broad on purpose: a build reads the whole toolchain, the
/// SDK, and half of `/usr/share`, and an allow-list of those is a guess that
/// fails as a mysterious build error. Writes, the installed application, the
/// live data, signals and the daemon port are the boundaries that matter, and
/// those are closed explicitly.
pub fn render(policy: &Policy) -> String {
    let mut out = String::new();
    out.push_str("(version 1)\n");
    out.push_str("(allow default)\n");
    out.push_str(";; --- writes: denied everywhere ---\n");
    out.push_str("(deny file-write*)\n");
    if !policy.denied.is_empty() {
        out.push_str(";; --- the live installation and its data, closed to reads too ---\n");
        for path in &policy.denied {
            let p = sbpl_string(&real_path(path));
            out.push_str(&format!("(deny file-read* (subpath {p}))\n"));
            out.push_str(&format!("(deny file-write* (subpath {p}))\n"));
        }
    }
    // The carve-outs come LAST, because the last matching rule wins. That
    // ordering is what lets a candidate workspace live *inside* an otherwise
    // closed directory — which it does: the candidate, its output and the
    // shared build caches all sit under the application data directory that
    // the rule above just denied wholesale. Reads are re-opened as well as
    // writes, or a worker could not read the source it is editing.
    out.push_str(";; --- the candidate, its output, and the designated caches ---\n");
    for path in &policy.writable {
        let p = sbpl_string(&real_path(path));
        out.push_str(&format!("(allow file-read* (subpath {p}))\n"));
        out.push_str(&format!("(allow file-write* (subpath {p}))\n"));
    }
    // Device nodes: /dev/null, the pty a build tool allocates for its own
    // children, /dev/stdout. Writing here reaches nothing of the user's.
    out.push_str("(allow file-write* (subpath \"/dev\"))\n");
    out.push_str(";; --- the running Redline: unreachable ---\n");
    // `(deny signal (target others))` is accepted and does nothing on macOS 14.
    // A bare deny followed by a same-sandbox allow is what actually holds, and
    // it keeps a build tool able to manage its own children.
    out.push_str("(deny signal)\n");
    out.push_str("(allow signal (target same-sandbox))\n");
    for path in AUTOMATION_BINARIES {
        out.push_str(&format!(
            "(deny process-exec (subpath {}))\n",
            sbpl_string(Path::new(path))
        ));
    }
    for port in &policy.denied_ports {
        out.push_str(&format!(
            "(deny network-outbound (remote ip \"localhost:{port}\"))\n"
        ));
    }
    out
}

/// A confined command, ready to spawn.
pub fn command(policy: &Policy, program: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(SANDBOX_EXEC);
    cmd.arg("-p").arg(render(policy));
    cmd.arg(program);
    cmd.args(args);
    cmd
}

/// Environment entries a confined worker must never inherit: the production
/// daemon's credential and the run-claim service it authorizes. A build script
/// that read them would be holding a token to the very application it is
/// forbidden to touch.
pub const STRIPPED_ENV: &[&str] = &[
    crate::auth::ENV_DAEMON_TOKEN,
    "REDLINE_RUN_CLAIM_URL",
    crate::runner::ENV_RUN_ID,
    crate::runner::ENV_RUN_NODE,
    crate::runner::ENV_RUN_ATTEMPT,
    crate::runtime_profile::ENV_ACTIVATION_TXN,
];

/// Remove the inherited production credentials from a command.
pub fn strip_inherited_credentials(cmd: &mut Command) {
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }
    // Anything a Claude session exported into this process would otherwise
    // follow a spawned agent into the candidate and re-home its transcripts.
    for (key, _) in std::env::vars() {
        if key.starts_with("CLAUDE") {
            cmd.env_remove(key);
        }
    }
}

/// The outcome of qualifying the adapter on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Qualification {
    /// Every guarantee was demonstrated. The listed checks all passed.
    Available { checks: Vec<String> },
    /// Confinement could not be established, and why. Preparation stops here.
    Unavailable { reason: String },
}

impl Qualification {
    pub fn is_available(&self) -> bool {
        matches!(self, Qualification::Available { .. })
    }
    pub fn reason(&self) -> Option<&str> {
        match self {
            Qualification::Unavailable { reason } => Some(reason),
            _ => None,
        }
    }
}

fn run_confined(policy: &Policy, script: &str) -> std::io::Result<std::process::Output> {
    let mut cmd = command(policy, Path::new("/bin/sh"), &["-c", script]);
    cmd.env_clear();
    cmd.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    cmd.output()
}

/// Demonstrate each guarantee against live resources. Cached per process: the
/// checks spawn processes and bind a socket, and the answer cannot change
/// while this build runs.
pub fn qualification() -> &'static Qualification {
    static RESULT: OnceLock<Qualification> = OnceLock::new();
    RESULT.get_or_init(qualify)
}

/// The qualification suite. Six demonstrations, each one a boundary the plan
/// depends on. Every failure names the check, because "sandboxing unavailable"
/// is not something a user can act on.
pub fn qualify() -> Qualification {
    let unavailable = |reason: String| Qualification::Unavailable { reason };
    if !Path::new(SANDBOX_EXEC).exists() {
        return unavailable(format!("{SANDBOX_EXEC} is not present on this system"));
    }
    let root = match tempdir("redline-confine-qualify") {
        Ok(dir) => dir,
        Err(e) => return unavailable(format!("could not create a scratch directory: {e}")),
    };
    let allowed = root.join("allowed");
    let secret = root.join("secret");
    if std::fs::create_dir_all(&allowed).is_err() || std::fs::create_dir_all(&secret).is_err() {
        let _ = std::fs::remove_dir_all(&root);
        return unavailable("could not populate the scratch directory".into());
    }
    if std::fs::write(secret.join("live.db"), b"private").is_err() {
        let _ = std::fs::remove_dir_all(&root);
        return unavailable("could not write the scratch fixture".into());
    }

    // A listener stands in for the production daemon. Denying its *actual*
    // port would make "connection refused" and "sandbox denied" indis-
    // tinguishable, and the check would pass on a machine where the filter
    // does nothing.
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&root);
            return unavailable(format!("could not bind a loopback listener: {e}"));
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&root);
            return unavailable(format!("could not read the listener's port: {e}"));
        }
    };

    let policy = Policy::default()
        .writable(&allowed)
        .denied(&secret)
        .denied_port(port);

    let mut checks = Vec::new();
    let mut fail: Option<String> = None;

    let mut check = |name: &str, script: String, want_success: bool, checks: &mut Vec<String>| {
        if fail.is_some() {
            return;
        }
        match run_confined(&policy, &script) {
            Ok(out) if out.status.success() == want_success => checks.push(name.to_string()),
            Ok(out) => {
                fail = Some(format!(
                    "confinement check '{name}' did not hold (expected the command to {}): {}",
                    if want_success { "succeed" } else { "be refused" },
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            Err(e) => fail = Some(format!("confinement check '{name}' could not run: {e}")),
        }
    };

    let allowed_file = allowed.join("probe");
    let outside_file = root.join("escaped");
    let secret_file = secret.join("live.db");
    let descendant_file = root.join("escaped-by-descendant");

    check(
        "writes land inside the candidate",
        format!("echo ok > {}", shell_quote(&allowed_file)),
        true,
        &mut checks,
    );
    check(
        "writes outside the candidate are refused",
        format!("echo bad > {}", shell_quote(&outside_file)),
        false,
        &mut checks,
    );
    check(
        "the live installation cannot be read",
        format!("cat {}", shell_quote(&secret_file)),
        false,
        &mut checks,
    );
    check(
        "a descendant process inherits the boundary",
        format!(
            "/bin/sh -c 'echo bad > {}'",
            shell_quote(&descendant_file)
        ),
        false,
        &mut checks,
    );
    check(
        "the production daemon's port is unreachable",
        format!("/usr/bin/nc -z -w 2 127.0.0.1 {port}"),
        false,
        &mut checks,
    );
    check(
        "automation tools cannot be executed",
        "/usr/bin/osascript -e 1".to_string(),
        false,
        &mut checks,
    );

    // The signal boundary needs a live process outside the sandbox to aim at,
    // so it does not fit the shell-script shape above.
    if fail.is_none() {
        match signal_boundary_holds(&policy) {
            Ok(()) => checks.push("the running application cannot be signalled".to_string()),
            Err(e) => fail = Some(e),
        }
    }

    // The escape checks are only meaningful if the *unconfined* action would
    // have worked. Otherwise a machine where `nc` is missing would "pass".
    if fail.is_none() && std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        fail = Some("the qualification listener was not reachable unconfined, so the network check proved nothing".into());
    }
    if fail.is_none() && std::fs::write(&outside_file, b"control").is_err() {
        fail = Some("the qualification scratch directory was not writable unconfined, so the write check proved nothing".into());
    }

    drop(listener);
    let _ = std::fs::remove_dir_all(&root);
    match fail {
        Some(reason) => unavailable(reason),
        None => Qualification::Available { checks },
    }
}

/// Demonstrate that a confined process cannot signal one outside its sandbox,
/// while still being able to manage its own children.
fn signal_boundary_holds(policy: &Policy) -> Result<(), String> {
    let mut victim = Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .map_err(|e| format!("could not start the signal-boundary fixture: {e}"))?;
    let pid = victim.id();
    let outcome = (|| {
        let out = run_confined(policy, &format!("/bin/kill -TERM {pid}"))
            .map_err(|e| format!("signal check could not run: {e}"))?;
        if out.status.success() {
            return Err("a confined process was able to signal one outside its sandbox".into());
        }
        // ...and it must still be able to signal its own children, or every
        // build tool that manages a subprocess breaks.
        let inner = run_confined(policy, "sleep 5 & p=$!; kill -TERM $p")
            .map_err(|e| format!("signal check could not run: {e}"))?;
        if !inner.status.success() {
            return Err("confinement also blocked a worker from signalling its own child".into());
        }
        Ok(())
    })();
    let _ = victim.kill();
    let _ = victim.wait();
    outcome
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// A unique scratch directory under the system temporary directory.
fn tempdir(prefix: &str) -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The complete environment a confined worker runs in: the caller's, minus
/// every production credential, plus what the build needs.
///
/// Callers `env_clear()` and then set exactly this, so the child's environment
/// is what was computed rather than "the parent's, minus the ones we
/// remembered to remove". An omission then shows up as a missing `PATH` —
/// loud and immediate — instead of as a leaked credential nobody notices.
pub fn worker_env(extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| !STRIPPED_ENV.contains(&k.as_str()) && !k.starts_with("CLAUDE"))
        .collect();
    for (k, v) in extra {
        env.insert((*k).to_string(), (*v).to_string());
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rendered_profile_closes_every_named_boundary() {
        let profile = render(
            &Policy::default()
                .writable("/tmp/candidate")
                .denied("/Applications/Redline.app")
                .denied_port(7676),
        );
        assert!(profile.starts_with("(version 1)\n(allow default)\n"));
        // Writes: denied, then carved.
        let deny_all = profile.find("(deny file-write*)").expect("blanket write deny");
        let carve = profile.find("(allow file-write*").expect("carve-out");
        assert!(deny_all < carve, "the carve-out must come after the deny");
        // The installed bundle is closed to reads as well as writes.
        assert!(profile.contains("(deny file-read* (subpath \"/Applications/Redline.app\"))"));
        // The signal pair, in the order that actually works.
        let deny_signal = profile.find("(deny signal)").expect("signal deny");
        let allow_own = profile
            .find("(allow signal (target same-sandbox))")
            .expect("same-sandbox allow");
        assert!(deny_signal < allow_own);
        assert!(profile.contains("(deny network-outbound (remote ip \"localhost:7676\"))"));
        assert!(profile.contains("/usr/bin/osascript"));
    }

    /// The shape the real policy has: the candidate workspace lives *inside*
    /// the application data directory the policy denies. Only the carve-out
    /// order makes that work, and getting it backwards would look like a
    /// mysterious "permission denied" halfway through every build.
    #[test]
    fn a_workspace_nested_inside_a_denied_directory_is_still_writable() {
        let root = std::env::temp_dir().join(format!("rl-nest-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        let candidate = data.join("self-develop/rel-1/source");
        std::fs::create_dir_all(&candidate).unwrap();
        std::fs::write(data.join("redline.db"), b"live").unwrap();
        let policy = Policy::default().denied(&data).writable(&candidate);

        let inside = candidate.join("src.rs");
        let out = run_confined(&policy, &format!("echo edited > {}", shell_quote(&inside))).unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        // ...and the live database beside it is still unreadable.
        let db = data.join("redline.db");
        let read = run_confined(&policy, &format!("cat {}", shell_quote(&db))).unwrap();
        assert!(!read.status.success(), "the live database must stay closed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn policy_paths_are_resolved_before_they_reach_the_profile() {
        // The bug this prevents: a policy written against /var/... matches
        // nothing, so an allow becomes a denial and a DENY BECOMES PERMISSION.
        let tmp = std::env::temp_dir().join(format!("rl-confine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let profile = render(&Policy::default().writable(&tmp));
        let resolved = real_path(&tmp);
        assert!(
            profile.contains(&resolved.to_string_lossy().to_string()),
            "profile must carry the resolved path"
        );
        if tmp != resolved {
            assert!(
                !profile.contains(&format!("(subpath \"{}\")", tmp.display())),
                "profile must not carry the unresolved path"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn real_path_resolves_a_path_that_does_not_exist_yet() {
        let base = std::env::temp_dir();
        let ghost = base.join("rl-does-not-exist").join("candidate");
        let resolved = real_path(&ghost);
        assert!(resolved.ends_with("rl-does-not-exist/candidate"));
        assert!(resolved.starts_with(base.canonicalize().unwrap()));
    }

    #[test]
    fn sbpl_strings_escape_quotes_and_backslashes() {
        let rendered = sbpl_string(Path::new("/tmp/we\"ird\\path"));
        assert_eq!(rendered, "\"/tmp/we\\\"ird\\\\path\"");
    }

    #[test]
    fn production_credentials_never_reach_a_worker() {
        for key in STRIPPED_ENV {
            assert!(!worker_env(&[]).contains_key(*key), "{key} leaked");
        }
        let injected = worker_env(&[("CARGO_TARGET_DIR", "/tmp/cache")]);
        assert_eq!(injected.get("CARGO_TARGET_DIR").map(String::as_str), Some("/tmp/cache"));
    }

    /// The real thing, on this machine. Not `#[ignore]`: it is the check the
    /// whole feature's safety rests on, it takes well under a second, and a
    /// macOS that stops honouring these rules is exactly what we need to hear
    /// about from a test run rather than from a damaged installation.
    #[test]
    #[cfg(target_os = "macos")]
    fn confinement_is_demonstrable_on_this_machine() {
        match qualify() {
            Qualification::Available { checks } => {
                assert_eq!(checks.len(), 7, "every boundary must be demonstrated: {checks:?}");
            }
            Qualification::Unavailable { reason } => {
                panic!("confinement could not be qualified: {reason}");
            }
        }
    }
}

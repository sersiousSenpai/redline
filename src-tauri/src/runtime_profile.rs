// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Which *instance* of Redline this process is.
//!
//! Redline can now build and launch a copy of itself (see `self_develop.rs`).
//! A candidate build has to be started for real — a bundle that links, but
//! panics before its first window, is not a release anyone should restart
//! into. So the preparer launches the packaged candidate and watches it boot.
//!
//! That is only safe if the second instance touches nothing the first one
//! owns. Changing the database path alone would not do it: the single-instance
//! plugin hands a second launch off to the incumbent and exits, `:7676` is
//! already bound, macOS WebView storage is keyed to the bundle identifier, and
//! the hook files, capture, background agents and update checks all reach out
//! of the process the moment it starts.
//!
//! The profile is therefore resolved **first** — before the database is
//! opened, before a plugin is registered, before a window exists — from the
//! environment the parent chose, and every one of those decisions reads it.
//! Production is the default and needs no environment at all, so an ordinary
//! double-click is unchanged and a missing variable can never silently
//! *downgrade* isolation: an unparseable probe request is a hard error, not a
//! fallback to production.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Selects the profile. Unset (or `production`) is the shipped app.
pub const ENV_PROFILE: &str = "REDLINE_RUNTIME_PROFILE";
/// Probe only: the disposable app-data directory. Required, absolute.
pub const ENV_DATA_DIR: &str = "REDLINE_PROFILE_DATA_DIR";
/// Probe only: the loopback port this instance's daemon binds. Required.
pub const ENV_PORT: &str = "REDLINE_PROFILE_PORT";
/// Probe only: where to write the boot report. Defaults to
/// `<data dir>/probe-report.json`.
pub const ENV_PROBE_REPORT: &str = "REDLINE_PROBE_REPORT";
/// Activation only: the transaction directory the helper created. Its presence
/// is what turns an ordinary production boot into a *verified* one.
pub const ENV_ACTIVATION_TXN: &str = "REDLINE_ACTIVATION_TXN";

/// The production daemon's address. Loopback-only by invariant; a probe never
/// uses it (that is the point).
pub const PRODUCTION_ADDR: &str = "127.0.0.1:7676";
/// The production daemon's port, as a number, for the confinement policies
/// that have to deny reaching it.
pub const PRODUCTION_PORT: u16 = 7676;

/// Ports a probe may be asked to bind. Deliberately excludes the production
/// daemon and the dev server: a typo must not let a probe take the port the
/// installed app is waiting to bind.
const PROBE_PORT_RANGE: std::ops::RangeInclusive<u16> = 49152..=65535;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileKind {
    /// The installed app the user launched.
    Production,
    /// A candidate build started by the preparer, against disposable data.
    Probe,
}

/// A production boot that a helper is watching, because it just swapped the
/// bundle. The handshake is written into this directory; the helper polls it
/// and rolls back if it never turns healthy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationContext {
    /// The transaction directory (`<data dir>/activation/<txn>`).
    pub dir: PathBuf,
}

impl ActivationContext {
    /// The transaction id — the directory's own name.
    pub fn txn_id(&self) -> String {
        self.dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProfile {
    kind: ProfileKind,
    data_dir: Option<PathBuf>,
    addr: String,
    probe_report: Option<PathBuf>,
    activation: Option<ActivationContext>,
}

impl RuntimeProfile {
    /// The shipped app: no overrides, every integration live.
    pub fn production() -> Self {
        Self {
            kind: ProfileKind::Production,
            data_dir: None,
            addr: PRODUCTION_ADDR.to_string(),
            probe_report: None,
            activation: None,
        }
    }

    pub fn is_probe(&self) -> bool {
        self.kind == ProfileKind::Probe
    }

    pub fn is_production(&self) -> bool {
        self.kind == ProfileKind::Production
    }

    /// Replaces the app-data directory Tauri would resolve. `None` in
    /// production — the real one.
    pub fn data_dir_override(&self) -> Option<&Path> {
        self.data_dir.as_deref()
    }

    /// What the daemon binds.
    pub fn daemon_addr(&self) -> &str {
        &self.addr
    }

    /// Whether the single-instance plugin is installed. A probe must NOT hand
    /// itself off to the installed app and exit — that would report a healthy
    /// boot the candidate never performed.
    pub fn single_instance(&self) -> bool {
        self.kind == ProfileKind::Production
    }

    /// Whether WebView storage persists. A probe uses a non-persistent store so
    /// it cannot read or corrupt the user's cookies, local storage or service
    /// workers, all of which macOS keys to the bundle identifier rather than to
    /// the data directory.
    pub fn persist_webview_storage(&self) -> bool {
        self.kind == ProfileKind::Production
    }

    /// Whether this instance is allowed to reach outside itself: install or
    /// repair hook files, run background agents and capture, check for
    /// updates, load extensions, talk to external integrations. False for a
    /// probe — everything it would touch belongs to the real installation.
    pub fn external_effects(&self) -> bool {
        self.kind == ProfileKind::Production
    }

    /// Where a probe writes what it managed to do. `None` in production.
    pub fn probe_report(&self) -> Option<&Path> {
        self.probe_report.as_deref()
    }

    /// Set when a helper swapped the bundle and is waiting to see this boot
    /// succeed.
    pub fn activation(&self) -> Option<&ActivationContext> {
        self.activation.as_ref()
    }

    /// A one-line description for logs and the boot report.
    pub fn describe(&self) -> String {
        match self.kind {
            ProfileKind::Production => match &self.activation {
                Some(ctx) => format!("production (activating {})", ctx.txn_id()),
                None => "production".to_string(),
            },
            ProfileKind::Probe => format!("probe on {}", self.addr),
        }
    }
}

/// Resolve a profile from an arbitrary environment. Pure, so the rules are
/// testable without touching the process environment.
pub fn resolve(env: &HashMap<String, String>) -> Result<RuntimeProfile, String> {
    let get = |k: &str| env.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let activation = match get(ENV_ACTIVATION_TXN) {
        Some(dir) => {
            let path = PathBuf::from(dir);
            if !path.is_absolute() {
                return Err(format!("{ENV_ACTIVATION_TXN} must be an absolute path"));
            }
            Some(ActivationContext { dir: path })
        }
        None => None,
    };
    match get(ENV_PROFILE) {
        None | Some("production") => Ok(RuntimeProfile {
            activation,
            ..RuntimeProfile::production()
        }),
        Some("probe") => {
            // Every probe input is required and validated. A probe that fell
            // back to a default would be a second production instance.
            let dir = get(ENV_DATA_DIR)
                .ok_or_else(|| format!("{ENV_PROFILE}=probe requires {ENV_DATA_DIR}"))?;
            let data_dir = PathBuf::from(dir);
            if !data_dir.is_absolute() {
                return Err(format!("{ENV_DATA_DIR} must be an absolute path"));
            }
            let port: u16 = get(ENV_PORT)
                .ok_or_else(|| format!("{ENV_PROFILE}=probe requires {ENV_PORT}"))?
                .parse()
                .map_err(|_| format!("{ENV_PORT} is not a port number"))?;
            if !PROBE_PORT_RANGE.contains(&port) {
                return Err(format!(
                    "{ENV_PORT} must be in {}..={} (the production daemon's port is never a probe's)",
                    PROBE_PORT_RANGE.start(),
                    PROBE_PORT_RANGE.end()
                ));
            }
            let probe_report = get(ENV_PROBE_REPORT)
                .map(PathBuf::from)
                .unwrap_or_else(|| data_dir.join("probe-report.json"));
            Ok(RuntimeProfile {
                kind: ProfileKind::Probe,
                data_dir: Some(data_dir),
                addr: format!("127.0.0.1:{port}"),
                probe_report: Some(probe_report),
                // A probe is never an activation: nothing was swapped for it.
                activation: None,
            })
        }
        Some(other) => Err(format!("unknown {ENV_PROFILE}: {other}")),
    }
}

static CURRENT: OnceLock<RuntimeProfile> = OnceLock::new();

/// Resolve the profile from the real environment and freeze it for the rest of
/// the process. Called once, at the very top of `run()`.
///
/// A malformed probe request exits rather than booting: the alternative is a
/// second *production* instance started by an automated pipeline, which is the
/// exact failure the profile exists to prevent.
pub fn init_from_env() -> &'static RuntimeProfile {
    CURRENT.get_or_init(|| {
        let env: HashMap<String, String> = std::env::vars().collect();
        match resolve(&env) {
            Ok(profile) => profile,
            Err(reason) => {
                eprintln!("Redline cannot start: {reason}");
                std::process::exit(2);
            }
        }
    })
}

/// The profile for this process. Production when nothing called
/// [`init_from_env`] — the case for unit tests and any embedding that never
/// runs the Tauri entry point.
pub fn current() -> &'static RuntimeProfile {
    CURRENT.get_or_init(RuntimeProfile::production)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn an_empty_environment_is_production() {
        let p = resolve(&env(&[])).unwrap();
        assert!(p.is_production());
        assert_eq!(p.daemon_addr(), PRODUCTION_ADDR);
        assert!(p.single_instance());
        assert!(p.persist_webview_storage());
        assert!(p.external_effects());
        assert!(p.data_dir_override().is_none());
        assert!(p.activation().is_none());
    }

    #[test]
    fn a_probe_isolates_every_shared_resource() {
        let p = resolve(&env(&[
            (ENV_PROFILE, "probe"),
            (ENV_DATA_DIR, "/tmp/redline-probe-1"),
            (ENV_PORT, "51234"),
        ]))
        .unwrap();
        assert!(p.is_probe());
        assert_eq!(p.daemon_addr(), "127.0.0.1:51234");
        assert_eq!(p.data_dir_override(), Some(Path::new("/tmp/redline-probe-1")));
        // The four isolations a data-directory change alone would miss.
        assert!(!p.single_instance());
        assert!(!p.persist_webview_storage());
        assert!(!p.external_effects());
        assert_ne!(p.daemon_addr(), PRODUCTION_ADDR);
        assert_eq!(
            p.probe_report(),
            Some(Path::new("/tmp/redline-probe-1/probe-report.json"))
        );
    }

    #[test]
    fn an_incomplete_probe_request_is_refused_not_downgraded() {
        // The dangerous failure mode: a probe that quietly becomes production.
        for missing in [
            env(&[(ENV_PROFILE, "probe")]),
            env(&[(ENV_PROFILE, "probe"), (ENV_DATA_DIR, "/tmp/x")]),
            env(&[(ENV_PROFILE, "probe"), (ENV_PORT, "51234")]),
        ] {
            assert!(resolve(&missing).is_err(), "{missing:?} must not resolve");
        }
    }

    #[test]
    fn a_probe_may_never_claim_the_production_port() {
        for port in ["7676", "1420", "80", "0"] {
            let err = resolve(&env(&[
                (ENV_PROFILE, "probe"),
                (ENV_DATA_DIR, "/tmp/x"),
                (ENV_PORT, port),
            ]))
            .unwrap_err();
            assert!(err.contains(ENV_PORT), "{port}: {err}");
        }
    }

    #[test]
    fn relative_paths_are_refused() {
        assert!(resolve(&env(&[
            (ENV_PROFILE, "probe"),
            (ENV_DATA_DIR, "relative/dir"),
            (ENV_PORT, "51234"),
        ]))
        .is_err());
        assert!(resolve(&env(&[(ENV_ACTIVATION_TXN, "relative/dir")])).is_err());
    }

    #[test]
    fn an_unknown_profile_is_an_error() {
        assert!(resolve(&env(&[(ENV_PROFILE, "staging")])).is_err());
    }

    #[test]
    fn activation_marks_a_production_boot_a_helper_is_watching() {
        let p = resolve(&env(&[(ENV_ACTIVATION_TXN, "/var/rl/activation/txn-7")])).unwrap();
        assert!(p.is_production());
        assert_eq!(p.activation().unwrap().txn_id(), "txn-7");
        assert!(p.describe().contains("txn-7"));
    }

    #[test]
    fn a_probe_is_never_an_activation() {
        // Otherwise a probe could satisfy a helper's handshake and get a
        // candidate accepted without the real bundle ever having booted.
        let p = resolve(&env(&[
            (ENV_PROFILE, "probe"),
            (ENV_DATA_DIR, "/tmp/x"),
            (ENV_PORT, "51234"),
            (ENV_ACTIVATION_TXN, "/var/rl/activation/txn-7"),
        ]))
        .unwrap();
        assert!(p.is_probe());
        assert!(p.activation().is_none());
    }
}

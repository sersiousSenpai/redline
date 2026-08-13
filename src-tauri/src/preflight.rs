// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! "Can this machine actually deliver a plan?" — one call, answered before the
//! user spends a sentence finding out.
//!
//! The front door promises that pressing ⏎ starts a real plan-mode session in
//! a real project. Everything that can silently break that promise is probed
//! here: the `claude` binary (today a missing one surfaces as the same error
//! string at every spawn site, only *after* you've tried to use a feature),
//! the curl the agent-write bridge needs, the interception mode (Paused
//! captures nothing at all), and the hook + skill install state.
//!
//! Nothing here duplicates existing logic — `resolve_claude_bin`, the mode
//! getter, `hook::get_status` and `skill::get_status` are all reused. This
//! module's only original work is the curl version parse, which is pure and
//! unit-tested. Tauri command only: no `/v1` route, so no `auth.rs`
//! `ROUTE_TABLE` entry and no goldens change.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProbe {
    /// The resolved path exists and is a file (or the bare name is on PATH).
    pub found: bool,
    /// What `resolve_claude_bin()` returned — shown so a wrong override is
    /// visible rather than mysterious.
    pub path: Option<String>,
    /// Which layer answered: `env`, `override`, `probe`, or `path`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurlProbe {
    /// New enough for `--variable` / `--expand-header` (>= 8.3).
    pub ok: bool,
    /// The reported `major.minor.patch`, or None when curl didn't answer.
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightStatus {
    pub claude: ClaudeProbe,
    pub curl: CurlProbe,
    /// "active" | "ambient" | "paused". Folded in here so ONE call answers
    /// the whole question; the `mode-changed` event App already listens for
    /// is the refresh trigger.
    pub mode: String,
    pub hook: crate::hook::HookStatus,
    pub skill: crate::skill::SkillStatus,
}

/// The curl release that introduced `--variable` / `--expand-header`. The
/// agent-write bridge (`auth.rs`) imports the daemon token with those flags
/// rather than letting the shell expand `$VAR`, which the agent bash sandbox
/// rejects — so an older curl means agents can read but never write back.
const CURL_MIN: (u32, u32) = (8, 3);

/// Parse `curl --version`'s first line: `curl 8.7.1 (x86_64-apple-darwin23.0)
/// libcurl/8.7.1 …` → `(8, 7)`. Tolerates a missing patch and trailing
/// qualifiers (`8.4.0-DEV`), and refuses anything that isn't the real banner.
pub fn parse_curl_version(text: &str) -> Option<(u32, u32)> {
    let line = text.lines().next()?.trim();
    let rest = line.strip_prefix("curl ")?;
    let token = rest.split_whitespace().next()?;
    let mut parts = token.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    // `8` alone is a valid (if unlikely) version; a non-numeric minor is not.
    let minor: u32 = match parts.next() {
        None => 0,
        Some(raw) => raw
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .filter(|s| !s.is_empty())?
            .parse()
            .ok()?,
    };
    Some((major, minor))
}

/// Full `major.minor.patch…` token for display, straight off the banner.
fn curl_version_token(text: &str) -> Option<String> {
    let line = text.lines().next()?.trim();
    let rest = line.strip_prefix("curl ")?;
    rest.split_whitespace().next().map(str::to_string)
}

/// Which layer of `resolve_claude_bin()` produced this answer. Recomputed
/// from the two explicit overrides only — the probe layers are not
/// re-executed, so this stays a label, never a second implementation.
fn claude_source(resolved: &str) -> &'static str {
    if std::env::var(crate::seat::ENV_CLAUDE_BIN)
        .ok()
        .is_some_and(|p| !p.trim().is_empty())
    {
        return "env";
    }
    if crate::seat::claude_bin_override().is_some() {
        return "override";
    }
    if resolved.contains('/') {
        "probe"
    } else {
        "path"
    }
}

/// `claude` resolved to a bare name: nothing was found by the location probe
/// OR the login-shell query, which is still correct when Redline was launched
/// from a terminal that has it on PATH. Check that before declaring it
/// missing — a false "can't find claude" on a working machine is worse than
/// no check at all.
fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

fn probe_claude() -> ClaudeProbe {
    let resolved = crate::claude_proc::resolve_claude_bin();
    let source = claude_source(&resolved);
    let (found, path) = if resolved.contains('/') {
        (Path::new(&resolved).is_file(), Some(resolved.clone()))
    } else {
        match on_path(&resolved) {
            Some(p) => (true, Some(p.to_string_lossy().into_owned())),
            None => (false, None),
        }
    };
    ClaudeProbe {
        found,
        path,
        source: source.to_string(),
    }
}

async fn probe_curl() -> CurlProbe {
    // `curl` as the spawned agent would find it, falling back to the CLT/system
    // binary (a Finder-launched app's minimal PATH still carries /usr/bin).
    let mut output = tokio::process::Command::new("curl")
        .arg("--version")
        .output()
        .await
        .ok();
    if output.is_none() {
        output = tokio::process::Command::new("/usr/bin/curl")
            .arg("--version")
            .output()
            .await
            .ok();
    }
    let Some(out) = output.filter(|o| o.status.success()) else {
        return CurlProbe {
            ok: false,
            version: None,
        };
    };
    let text = String::from_utf8_lossy(&out.stdout);
    match parse_curl_version(&text) {
        Some(v) => CurlProbe {
            ok: v >= CURL_MIN,
            version: curl_version_token(&text),
        },
        None => CurlProbe {
            ok: false,
            version: None,
        },
    }
}

/// One answer to "can this machine deliver a plan". Async because the curl
/// probe and the `claude` login-shell fallback both spawn a child; neither may
/// block the UI thread on a cold boot.
#[tauri::command(async)]
pub async fn preflight_status(settings: tauri::State<'_, crate::Settings>) -> Result<PreflightStatus, String> {
    let mode = settings.get().as_str().to_string();
    let claude = tokio::task::spawn_blocking(probe_claude)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PreflightStatus {
        claude,
        curl: probe_curl().await,
        mode,
        hook: crate::hook::get_status(),
        skill: crate::skill::get_status(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_real_banner() {
        let banner = "curl 8.7.1 (x86_64-apple-darwin23.0) libcurl/8.7.1 (SecureTransport) LibreSSL/3.3.6 zlib/1.2.12\nRelease-Date: 2024-03-27";
        assert_eq!(parse_curl_version(banner), Some((8, 7)));
        assert_eq!(curl_version_token(banner).as_deref(), Some("8.7.1"));
    }

    #[test]
    fn parses_the_macos_13_banner_that_fails_the_gate() {
        // What macOS 11-13 actually ship, and why this check exists.
        let banner = "curl 7.88.1 (x86_64-apple-darwin22.0) libcurl/7.88.1";
        assert_eq!(parse_curl_version(banner), Some((7, 88)));
        assert!(parse_curl_version(banner).unwrap() < CURL_MIN);
    }

    #[test]
    fn the_gate_sits_exactly_at_8_3() {
        assert!(parse_curl_version("curl 8.3.0 (x)").unwrap() >= CURL_MIN);
        assert!(parse_curl_version("curl 8.2.9 (x)").unwrap() < CURL_MIN);
        assert!(parse_curl_version("curl 9.0.0 (x)").unwrap() >= CURL_MIN);
    }

    #[test]
    fn tolerates_qualifiers_and_a_missing_patch() {
        assert_eq!(parse_curl_version("curl 8.4.0-DEV (x)"), Some((8, 4)));
        assert_eq!(parse_curl_version("curl 8.4 (x)"), Some((8, 4)));
        assert_eq!(parse_curl_version("curl 8 (x)"), Some((8, 0)));
        assert_eq!(parse_curl_version("curl 8.10.1-rc1 (x)"), Some((8, 10)));
    }

    #[test]
    fn refuses_anything_that_is_not_the_banner() {
        for junk in [
            "",
            "\n",
            "not curl at all",
            "curl",
            "curl \n",
            "curl x.y.z",
            "libcurl/8.7.1",
            "wcurl 8.7.1",
            "curl v8.7.1",
        ] {
            assert_eq!(parse_curl_version(junk), None, "should refuse {junk:?}");
        }
    }

    #[test]
    fn reads_only_the_first_line() {
        // A shell rc banner ahead of the real output must not be parsed as a
        // version, and a version on line 2 must not be trusted either.
        assert_eq!(parse_curl_version("hello\ncurl 8.7.1 (x)"), None);
    }

    #[test]
    fn a_bare_resolution_reports_path_not_probe() {
        // Only meaningful with no overrides set — with one, "env"/"override"
        // is the correct label and the assertion below would be wrong.
        if std::env::var(crate::seat::ENV_CLAUDE_BIN).is_ok()
            || crate::seat::claude_bin_override().is_some()
        {
            return;
        }
        assert_eq!(claude_source("claude"), "path");
        assert_eq!(claude_source("/usr/local/bin/claude"), "probe");
    }

    #[test]
    fn on_path_finds_a_real_binary_and_misses_a_fake_one() {
        assert!(on_path("sh").is_some());
        assert!(on_path("redline-definitely-not-a-real-binary").is_none());
    }
}

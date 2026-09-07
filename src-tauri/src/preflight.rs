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

/// The same three questions for `codex`, plus the two that only apply to it.
/// Read by the front door when the stored backend choice is Codex — a Claude
/// user never sees any of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProbe {
    /// The resolved path exists (or the bare name is on PATH).
    pub found: bool,
    /// What `resolve_codex_bin()` returned. Shown because it is the whole
    /// point: on a machine with the ChatGPT app AND an old `brew` install,
    /// seeing which one answered is the difference between a working plan
    /// session and one that dies at the first `resume`.
    pub path: Option<String>,
    /// `env` | `override` | `probe` | `path`.
    pub source: String,
    /// Present AND new enough: `--help` lists `app-server`, `resume` and
    /// `exec`, AND `codex exec --help` lists `fork` and `resume` — the
    /// non-interactive pair a plan comment's discussion thread runs on
    /// (`fork.rs`). A 0.24-era build is `found: true, usable: false`.
    pub usable: bool,
    /// `~/.codex/auth.json` carries a credential. A present, hooked, logged-
    /// *out* codex spins forever over nothing, which is the exact failure
    /// shape readiness exists to name.
    pub signed_in: bool,
    /// The config profile carrying the plan contract (`codex_profile`). Its
    /// own probe because `codex -p <name>` with no such file is SILENT: the
    /// session plans, looks fine, and then loses every block-identity sidecar
    /// on the first revision.
    pub profile: crate::codex_profile::CodexProfileStatus,
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
pub struct ExtensionToolchainProbe {
    /// `cargo` is reachable (PATH, or the rustup default `~/.cargo/bin`).
    pub cargo: bool,
    /// The `wasm32-unknown-unknown` target is installed — what `build.sh`
    /// actually compiles for. False whenever rustup itself is missing.
    pub wasm_target: bool,
    /// The staged ABI / SDK / template dirs of the checkout this binary was
    /// built from (`extension_scaffold`'s resolvers) — the dirs a pack
    /// author's plan session is granted via `--add-dir`. `None` once the
    /// clone has moved; the launch simply grants nothing then.
    pub abi_dir: Option<String>,
    pub sdk_dir: Option<String>,
    pub template_dir: Option<String>,
}

/// The whole integration-health answer: "can this machine deliver a plan", and
/// everything the setup surfaces need to say why not.
///
/// This is deliberately ONE payload rather than the six commands boot used to
/// fire (`get_hook_status`, `get_codex_hook_status`, `get_skill_status`,
/// `get_codex_skill_status`, `get_daemon_status`, `preflight_status`). Three of
/// those recomputed the *same* facts — the codex `--help` capability probe ran
/// once for the hook status and again, uncached, inside the preflight — and
/// every one of them was a separate IPC round trip on the critical path.
///
/// Fields that a given launch cannot need are `None`, not fabricated: a Claude
/// user's payload carries no codex probe at all, so nothing spawns `codex
/// --help` on their machine and no derivation can accidentally read a
/// default-shaped answer as a real one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightStatus {
    pub claude: ClaudeProbe,
    /// `None` when the selected backend is Claude — see `probe_codex`, which
    /// spawns a child process this user has no reason to pay for.
    pub codex: Option<CodexProbe>,
    pub curl: CurlProbe,
    /// "active" | "ambient" | "paused". Folded in here so ONE call answers
    /// the whole question; the `mode-changed` event App already listens for
    /// is the refresh trigger.
    pub mode: String,
    pub hook: crate::hook::HookStatus,
    pub skill: crate::skill::SkillStatus,
    /// Redline's Stop + capture hooks in `~/.codex/hooks.json`. `None` on the
    /// same condition as `codex` — reading it runs the capability probe.
    pub codex_hook: Option<crate::codex_hook::CodexHookStatus>,
    /// The Codex-side skill install. `None` on the same condition.
    pub codex_skill: Option<crate::skill::SkillStatus>,
    /// Can this machine BUILD an extension pack? Advisory, never blocking:
    /// planning one needs no toolchain, compiling it does. `None` unless the
    /// launch target actually is an extension pack — `rustup target list`
    /// is a child process, and a plain build never needs the answer.
    pub extension: Option<ExtensionToolchainProbe>,
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

/// Which layer of `resolve_codex_bin()` answered. Same label-only discipline
/// as `claude_source` — the probe layers are never re-executed here.
fn codex_source(resolved: &str) -> &'static str {
    if std::env::var(crate::seat::ENV_CODEX_BIN)
        .ok()
        .is_some_and(|p| !p.trim().is_empty())
    {
        return "env";
    }
    if crate::seat::codex_bin_override().is_some() {
        return "override";
    }
    if resolved.contains('/') {
        "probe"
    } else {
        "path"
    }
}

/// Does `~/.codex/auth.json` carry a usable credential? Either the OAuth
/// token set (`codex login`) or an API key.
///
/// Deliberately NOT `codex doctor`, which answers the same question among
/// thirty others and takes **14 seconds** on this machine — measured. The
/// front door's preflight runs on boot and on every mode change; a 14s child
/// process there would be a worse bug than the one it diagnoses. `logout`
/// removes exactly this file, so reading it is the same signal for free.
pub fn codex_auth_present(auth_json: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(auth_json) else {
        return false;
    };
    let nonempty = |v: Option<&serde_json::Value>| {
        v.and_then(serde_json::Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    };
    nonempty(value.get("OPENAI_API_KEY")) || nonempty(value.pointer("/tokens/access_token"))
}

fn probe_codex() -> CodexProbe {
    let resolved = crate::codex_app_server::resolve_codex_bin();
    let source = codex_source(&resolved);
    let (found, path) = if resolved.contains('/') {
        (Path::new(&resolved).is_file(), Some(resolved.clone()))
    } else {
        match on_path(&resolved) {
            Some(p) => (true, Some(p.to_string_lossy().into_owned())),
            None => (false, None),
        }
    };
    let usable = found && crate::codex_app_server::codex_capability(&resolved).0;
    let signed_in = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|h| h.join(".codex/auth.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|text| codex_auth_present(&text));
    CodexProbe {
        found,
        path,
        source: source.to_string(),
        usable,
        signed_in,
        profile: crate::codex_profile::get_status(),
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

/// Does `rustup target list --installed` name wasm32-unknown-unknown? Exact
/// line match: the banner-free list is one target triple per line, and a
/// substring match would be fooled by e.g. `wasm32-unknown-unknown-...`
/// variants a future rustup might print.
pub fn has_wasm_target(text: &str) -> bool {
    text.lines().any(|l| l.trim() == "wasm32-unknown-unknown")
}

/// A rustup-managed tool as the launched terminal would find it: PATH first,
/// then the rustup default `~/.cargo/bin` — present even under a Finder
/// launch's minimal PATH, which never carries cargo.
fn cargo_tool(name: &str) -> Option<PathBuf> {
    if let Some(p) = on_path(name) {
        return Some(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let candidate = home.join(".cargo/bin").join(name);
    candidate.is_file().then_some(candidate)
}

async fn probe_extension_toolchain() -> ExtensionToolchainProbe {
    let cargo = cargo_tool("cargo").is_some();
    let wasm_target = match cargo_tool("rustup") {
        Some(rustup) => tokio::process::Command::new(rustup)
            .args(["target", "list", "--installed"])
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .is_some_and(|o| has_wasm_target(&String::from_utf8_lossy(&o.stdout))),
        None => false,
    };
    let dir = |d: Option<std::path::PathBuf>| d.map(|p| p.to_string_lossy().into_owned());
    ExtensionToolchainProbe {
        cargo,
        wasm_target,
        abi_dir: dir(crate::extension_scaffold::abi_dir()),
        sdk_dir: dir(crate::extension_scaffold::sdk_dir()),
        template_dir: dir(crate::extension_scaffold::template_dir()),
    }
}

/// One answer to "can this machine deliver a plan".
///
/// `backend` is the launch target the front door would actually use — the
/// frontend's own `Backend` identifiers, `"claude-code"` | `"codex"` (see
/// `src/lib/backendChoice.ts`; `None` means "probe both", which the setup
/// panel wants and a launch never does). `extension` says the target is an
/// extension pack, which is the only case that needs a Rust toolchain answer.
///
/// Everything independent runs **concurrently**. That is not micro-tuning: the
/// serial version awaited the binary probes, then curl, then `rustup target
/// list` — three child processes back to back, each with its own process
/// spawn latency, on a path the front door's readiness strip waits for. The
/// blocking probes ride `spawn_blocking` (they use `std::process`, and one
/// layer can still reach an interactive login shell on a machine with an
/// exotic install), and the tokio-native ones are plain futures.
#[tauri::command(async)]
pub async fn preflight_status(
    settings: tauri::State<'_, crate::Settings>,
    backend: Option<String>,
    extension: Option<bool>,
) -> Result<PreflightStatus, String> {
    // Post-boot maintenance repairs the hook files this very function is about
    // to read. Waiting here is what makes deferring those repairs safe: the
    // launch path runs a preflight, so a launch cannot outrun them. Returns
    // immediately once maintenance is done — which, for every call after the
    // first, it is. Bounded inside `ready()`.
    crate::postboot::ready().await;
    let mode = settings.get().as_str().to_string();
    // "Not claude-code" rather than "is codex": an unset/unknown choice must
    // probe both, because withholding an answer the door needs is a worse
    // failure than one extra `--help` on a machine we know nothing about.
    let want_codex = backend.as_deref() != Some("claude-code");
    let want_extension = extension.unwrap_or(false);

    let bins = tokio::task::spawn_blocking(move || {
        let claude = probe_claude();
        // All three codex answers share the one cached capability probe, so
        // this is a single `--help` at most, not three.
        let codex = want_codex.then(probe_codex);
        let codex_hook = want_codex.then(crate::codex_hook::get_status);
        let codex_skill = want_codex.then(crate::skill::get_codex_status);
        (claude, codex, codex_hook, codex_skill)
    });
    // Reads two files and compares their contents; cheap, but it is still I/O
    // and it has no business on the UI thread.
    let files =
        tokio::task::spawn_blocking(|| (crate::hook::get_status(), crate::skill::get_status()));
    let curl = probe_curl();
    let ext = async move {
        match want_extension {
            true => Some(probe_extension_toolchain().await),
            false => None,
        }
    };

    let (bins, files, curl, extension) = tokio::join!(bins, files, curl, ext);
    let (claude, codex, codex_hook, codex_skill) = bins.map_err(|e| e.to_string())?;
    let (hook, skill) = files.map_err(|e| e.to_string())?;
    Ok(PreflightStatus {
        claude,
        codex,
        curl,
        mode,
        hook,
        skill,
        codex_hook,
        codex_skill,
        extension,
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
    fn wasm_target_matches_the_exact_triple_only() {
        assert!(has_wasm_target("aarch64-apple-darwin\nwasm32-unknown-unknown\n"));
        assert!(has_wasm_target("  wasm32-unknown-unknown  "));
        assert!(!has_wasm_target(""));
        assert!(!has_wasm_target("aarch64-apple-darwin\n"));
        // A future variant triple must not satisfy the exact check.
        assert!(!has_wasm_target("wasm32-unknown-unknown-extra\n"));
        assert!(!has_wasm_target("also wasm32-unknown-unknown here\n"));
    }

    #[test]
    fn extension_dirs_resolve_inside_this_checkout() {
        // This test runs from the source tree, so all three staged dirs
        // exist; what matters is that they resolve absolute and distinct.
        let dirs = [
            crate::extension_scaffold::abi_dir(),
            crate::extension_scaffold::sdk_dir(),
            crate::extension_scaffold::template_dir(),
        ];
        for d in &dirs {
            let d = d.as_ref().expect("staged dir missing in a dev tree");
            assert!(d.is_absolute());
            assert!(d.is_dir());
        }
        assert_ne!(dirs[0], dirs[1]);
        assert_ne!(dirs[1], dirs[2]);
    }

    #[test]
    fn auth_json_reads_both_credential_shapes() {
        // The OAuth shape `codex login` actually writes.
        assert!(codex_auth_present(
            r#"{"OPENAI_API_KEY":null,"tokens":{"access_token":"abc","refresh_token":"d"},"last_refresh":"x"}"#
        ));
        // An API-key install.
        assert!(codex_auth_present(r#"{"OPENAI_API_KEY":"sk-x"}"#));
        // What `codex logout` leaves behind, and the near-misses.
        assert!(!codex_auth_present(r#"{"OPENAI_API_KEY":null,"tokens":null}"#));
        assert!(!codex_auth_present(r#"{"tokens":{"access_token":"  "}}"#));
        assert!(!codex_auth_present("{}"));
        assert!(!codex_auth_present("not json"));
        assert!(!codex_auth_present(""));
    }

    #[test]
    fn on_path_finds_a_real_binary_and_misses_a_fake_one() {
        assert!(on_path("sh").is_some());
        assert!(on_path("redline-definitely-not-a-real-binary").is_none());
    }
}

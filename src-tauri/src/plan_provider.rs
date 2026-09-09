// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Native planning provider discovery. Probes consume no model request, are
//! selected-provider-only, and cap both execution time and captured output.
use crate::{
    codex_app_server::CodexModel, db::Database, provider_hooks::HookStatus, skill::SkillStatus,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const OUTPUT_LIMIT: usize = 1024 * 1024;
static OVERRIDES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static CURSOR_CAPABILITIES: OnceLock<crate::binprobe::Cache<Result<Capabilities, String>>> =
    OnceLock::new();

static ANTIGRAVITY_CAPABILITIES: OnceLock<crate::binprobe::Cache<Result<Capabilities, String>>> =
    OnceLock::new();
fn capability_cache(
    backend: &str,
) -> &'static OnceLock<crate::binprobe::Cache<Result<Capabilities, String>>> {
    if backend == "cursor" {
        &CURSOR_CAPABILITIES
    } else {
        &ANTIGRAVITY_CAPABILITIES
    }
}

fn names(backend: &str) -> Result<&'static [&'static str], String> {
    match backend {
        "cursor" => Ok(&["agent", "cursor-agent"]),
        "antigravity" => Ok(&["agy"]),
        _ => Err(format!("unsupported native planning provider: {backend}")),
    }
}
fn executable(path: &Path) -> bool {
    let Ok(meta) = path.metadata() else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProvider {
    pub path: String,
    pub source: String,
    pub found: bool,
    pub identity: String,
}
fn resolved(path: PathBuf, source: &str) -> ResolvedProvider {
    let found = executable(&path);
    let canonical = path.canonicalize().unwrap_or(path);
    let meta = canonical.metadata().ok();
    let identity = format!(
        "{}:{}:{:?}",
        canonical.display(),
        meta.as_ref().map_or(0, |m| m.len()),
        meta.and_then(|m| m.modified().ok())
    );
    ResolvedProvider {
        path: canonical.to_string_lossy().into_owned(),
        source: source.into(),
        found,
        identity,
    }
}
fn expand_home(path: &str, home: &Path) -> PathBuf {
    path.strip_prefix("~/")
        .map(|tail| home.join(tail))
        .unwrap_or_else(|| PathBuf::from(path))
}

pub fn load_overrides(db: &Database) {
    let mut values = OVERRIDES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for backend in ["cursor", "antigravity"] {
        if let Some(path) = db
            .get_setting(&format!("{backend}_bin_path"))
            .filter(|p| !p.trim().is_empty())
        {
            values.insert(backend.into(), path);
        } else {
            values.remove(backend);
        }
    }
}

pub fn resolve(backend: &str) -> Result<ResolvedProvider, String> {
    let binaries = names(backend)?;
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let key = format!("REDLINE_{}_BIN", backend.to_ascii_uppercase());
    if let Some(path) = std::env::var(&key).ok().filter(|p| !p.trim().is_empty()) {
        return Ok(resolved(expand_home(path.trim(), &home), "environment"));
    }
    let override_path = OVERRIDES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(backend)
        .cloned();
    if let Some(path) = override_path {
        return Ok(resolved(expand_home(&path, &home), "override"));
    }
    let mut candidates = Vec::new();
    for name in binaries {
        candidates.extend([
            home.join(".local/bin").join(name),
            home.join(".cursor/bin").join(name),
            PathBuf::from("/opt/homebrew/bin").join(name),
            PathBuf::from("/usr/local/bin").join(name),
        ]);
    }
    if backend == "cursor" {
        candidates.push(home.join(".cursor/cli/latest/cursor-agent"));
    } else {
        candidates.push(home.join(".antigravity/bin/agy"));
    }
    for root in [PathBuf::from("/Applications"), home.join("Applications")] {
        candidates.push(root.join(if backend == "cursor" {
            "Cursor.app/Contents/Resources/app/bin/cursor-agent"
        } else {
            "Antigravity.app/Contents/Resources/app/bin/agy"
        }));
    }
    if let Some(path) = candidates.into_iter().find(|p| executable(p)) {
        return Ok(resolved(path, "known-path"));
    }
    // A GUI launch sees a sparse PATH. Only fixed provider names reach a shell;
    // user overrides are always executable paths, never shell source.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    for name in binaries {
        if let Ok(output) = run_bounded(
            &shell,
            &["-ilc", &format!("command -v {name}")],
            PROBE_TIMEOUT,
        ) {
            if output.success {
                if let Some(path) = output
                    .stdout
                    .lines()
                    .rev()
                    .map(str::trim)
                    .map(PathBuf::from)
                    .find(|p| p.is_absolute() && executable(p))
                {
                    return Ok(resolved(path, "login-shell"));
                }
            }
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in binaries {
                let path = dir.join(name);
                if executable(&path) {
                    return Ok(resolved(path, "path"));
                }
            }
        }
    }
    Ok(resolved(PathBuf::from(binaries[0]), "missing"))
}

pub fn set_override(
    db: &Database,
    backend: &str,
    path: Option<String>,
) -> Result<ProviderProbe, String> {
    names(backend)?;
    let path = path.filter(|p| !p.trim().is_empty());
    let path = if let Some(path) = path {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
        let path = expand_home(path.trim(), &home);
        if !path.is_absolute() || !executable(&path) {
            return Err("Choose an executable CLI file using its absolute path".into());
        }
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    };
    db.set_setting(
        &format!("{backend}_bin_path"),
        path.as_deref().unwrap_or(""),
    )
    .map_err(|e| e.to_string())?;
    load_overrides(db);
    if let Ok(bin) = resolve(backend) {
        crate::binprobe::forget(capability_cache(backend), &bin.path);
    }
    probe(backend)
}

#[derive(Debug)]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Each pipe reader takes at most LIMIT+1 bytes; dropping the pipe then bounds
/// a noisy child. A private process group ensures timeouts reap descendants too.
pub fn run_bounded(bin: &str, args: &[&str], timeout: Duration) -> Result<CommandOutput, String> {
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run provider CLI: {e}"))?;
    let out = child.stdout.take().ok_or("provider stdout unavailable")?;
    let err = child.stderr.take().ok_or("provider stderr unavailable")?;
    let read = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream
                .take((OUTPUT_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        })
    };
    let stdout = read(Box::new(out));
    let stderr = read(Box::new(err));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(e) => break Err(format!("could not wait for provider CLI: {e}")),
            Ok(None) if Instant::now() >= deadline => {
                break Err("provider CLI probe timed out".into())
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    // Even an exited wrapper can leave descendants holding the pipes open.
    // This group was created exclusively for this bounded probe invocation.
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if status.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let stdout = stdout
        .join()
        .map_err(|_| "provider stdout reader failed")?
        .map_err(|e| e.to_string())?;
    let stderr = stderr
        .join()
        .map_err(|_| "provider stderr reader failed")?
        .map_err(|e| e.to_string())?;
    if stdout.len() > OUTPUT_LIMIT || stderr.len() > OUTPUT_LIMIT {
        return Err("provider CLI probe output exceeded its limit".into());
    }
    Ok(CommandOutput {
        success: status?.success(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[derive(Debug, Clone)]
struct Capabilities {
    usable: bool,
    version: Option<String>,
    efforts: Vec<String>,
}
fn help_compatible(backend: &str, help: &str) -> bool {
    let required: &[&str] = if backend == "cursor" {
        &[
            "Cursor Agent",
            "--mode",
            "plan",
            "ask",
            "--resume",
            "--model",
            "models",
        ]
    } else {
        &[
            "Usage of agy",
            "--mode",
            "plan",
            "--conversation",
            "--model",
            "--effort",
            "--prompt-interactive",
            "models",
        ]
    };
    required.iter().all(|needle| help.contains(needle))
}
fn effort_options(help: &str) -> Vec<String> {
    help.lines()
        .find(|line| line.contains("--effort"))
        .and_then(|line| line.split_once('('))
        .and_then(|(_, tail)| tail.split_once(')'))
        .map(|(values, _)| {
            values
                .split('|')
                .filter(|v| !v.is_empty() && v.bytes().all(|c| c.is_ascii_alphanumeric()))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn capabilities(backend: &str, bin: &str) -> Result<Capabilities, String> {
    crate::binprobe::cached(capability_cache(backend), bin, || {
        let help = run_bounded(bin, &["--help"], PROBE_TIMEOUT)?;
        let text = format!("{}\n{}", help.stdout, help.stderr);
        let usable = help.success && help_compatible(backend, &text);
        // Both verified native CLIs support --version, although agy omits it
        // from its usage listing. Only invoke it after a recognized help banner.
        let version = if usable {
            run_bounded(bin, &["--version"], PROBE_TIMEOUT)
                .ok()
                .filter(|o| o.success)
                .map(|o| o.stdout.trim().to_owned())
                .filter(|v| !v.is_empty() && v.len() < 128)
        } else {
            None
        };
        Ok(Capabilities {
            usable,
            version,
            efforts: if backend == "antigravity" {
                effort_options(&text)
            } else {
                vec![]
            },
        })
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbe {
    pub found: bool,
    pub path: String,
    pub source: String,
    pub usable: bool,
    pub version: Option<String>,
    pub identity: String,
    pub authentication: String,
    pub hook: HookStatus,
    pub skill: SkillStatus,
    pub error: Option<String>,
}
fn cursor_auth(text: &str) -> &'static str {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return "unknown";
    };
    match value.get("isAuthenticated").and_then(Value::as_bool) {
        Some(true) => "signed-in",
        Some(false) => "signed-out",
        None => "unknown",
    }
}
fn antigravity_auth(output: &CommandOutput) -> &'static str {
    if output.success && parse_catalog("antigravity", &output.stdout, &[]).is_ok() {
        return "signed-in";
    }
    let text = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if [
        "not logged in",
        "not authenticated",
        "authentication required",
        "please log in",
        "please login",
        "please sign in",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        "signed-out"
    } else {
        "unknown"
    }
}
pub fn probe(backend: &str) -> Result<ProviderProbe, String> {
    let bin = resolve(backend)?;
    let caps = if bin.found {
        capabilities(backend, &bin.path)
    } else {
        Err("Provider CLI was not found".into())
    };
    let usable = caps.as_ref().is_ok_and(|c| c.usable);
    let authentication = if usable {
        if backend == "cursor" {
            run_bounded(&bin.path, &["status", "--format", "json"], PROBE_TIMEOUT)
                .map(|o| cursor_auth(&o.stdout))
                .unwrap_or("unknown")
        } else {
            run_bounded(&bin.path, &["models"], PROBE_TIMEOUT)
                .map(|o| antigravity_auth(&o))
                .unwrap_or("unknown")
        }
    } else {
        "unknown"
    };
    Ok(ProviderProbe {
        found: bin.found,
        path: bin.path,
        source: bin.source,
        identity: bin.identity,
        usable,
        version: caps.as_ref().ok().and_then(|c| c.version.clone()),
        authentication: authentication.into(),
        hook: crate::provider_hooks::status(backend),
        skill: crate::skill::get_provider_status(backend)?,
        error: caps.err().or_else(|| {
            (!usable).then(|| {
                "This CLI does not expose the required native planning and resume capabilities"
                    .into()
            })
        }),
    })
}

/// Preserve provider slugs verbatim. Cursor efforts are encoded in its model
/// identifiers; Antigravity exposes the separate live --effort option.
fn parse_catalog(backend: &str, text: &str, efforts: &[String]) -> Result<Vec<CodexModel>, String> {
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in text.lines() {
        let pair = if backend == "cursor" {
            line.trim().split_once(" - ")
        } else {
            line.trim().split_once('\t')
        };
        let Some((slug, label)) = pair else { continue };
        if slug.is_empty()
            || slug.len() > 256
            || !slug
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.:/".contains(&c))
            || label.trim().is_empty()
            || !seen.insert(slug.to_owned())
        {
            continue;
        }
        rows.push(CodexModel {
            slug: slug.into(),
            display_name: label.trim().trim_end_matches(" (default)").into(),
            description: String::new(),
            default_effort: None,
            efforts: efforts.to_vec(),
        });
    }
    if rows.is_empty() {
        Err("Provider returned no selectable models".into())
    } else {
        Ok(rows)
    }
}
pub fn model_catalog(backend: &str) -> Result<Vec<CodexModel>, String> {
    let bin = resolve(backend)?;
    if !bin.found {
        return Err("Provider CLI was not found".into());
    }
    let caps = capabilities(backend, &bin.path)?;
    if !caps.usable {
        return Err("Provider CLI lacks native planning capabilities".into());
    }
    let output = run_bounded(&bin.path, &["models"], PROBE_TIMEOUT)?;
    if !output.success {
        return Err("Provider model discovery failed; check the CLI login and retry".into());
    }
    parse_catalog(backend, &output.stdout, &caps.efforts)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_uses_live_slugs_without_invented_aliases() {
        let cursor=parse_catalog("cursor","Available models\nauto - Auto (default)\nclaude-model-high - Claude model High\nTip: use --model x",&[]).unwrap();
        assert_eq!(cursor.len(), 2);
        assert_eq!(cursor[0].display_name, "Auto");
        assert!(cursor[1].efforts.is_empty());
        let agy = parse_catalog(
            "antigravity",
            "gemini-model-high\tGemini Model (High)\n",
            &["low".into(), "high".into()],
        )
        .unwrap();
        assert_eq!(agy[0].slug, "gemini-model-high");
        assert_eq!(agy[0].efforts, vec!["low", "high"]);
        assert!(parse_catalog("cursor", "Error: authentication required", &[]).is_err());
    }
    #[test]
    fn authentication_does_not_guess_from_private_credential_storage() {
        assert_eq!(cursor_auth(r#"{"isAuthenticated":true}"#), "signed-in");
        assert_eq!(cursor_auth(r#"{"isAuthenticated":false}"#), "signed-out");
        assert_eq!(cursor_auth("private store unavailable"), "unknown");
        for (text, expected) in [
            ("connection timeout", "unknown"),
            ("Please sign in", "signed-out"),
        ] {
            assert_eq!(
                antigravity_auth(&CommandOutput {
                    success: false,
                    stdout: String::new(),
                    stderr: text.into()
                }),
                expected
            );
        }
    }
    #[test]
    fn detects_required_capabilities_and_live_efforts() {
        assert!(!help_compatible("cursor", "agent --mode --resume"));
        assert_eq!(
            effort_options("  --effort Reasoning effort (low|medium|high)"),
            vec!["low", "medium", "high"]
        );
        assert!(names("unknown").is_err());
    }
    #[test]
    #[ignore = "requires explicit REDLINE_CURSOR_BIN and REDLINE_ANTIGRAVITY_BIN; metadata only"]
    fn installed_native_cli_metadata_fixtures() {
        for backend in ["cursor", "antigravity"] {
            let key = format!("REDLINE_{}_BIN", backend.to_ascii_uppercase());
            let bin = std::env::var(&key).expect("pass explicit fixture executable paths");
            let caps = capabilities(backend, &bin).unwrap();
            assert!(caps.usable, "{backend} help lost required capabilities");
            assert!(caps.version.is_some());
            let catalog = model_catalog(backend).unwrap();
            assert!(!catalog.is_empty());
            let health = probe(backend).unwrap();
            assert_eq!(health.authentication, "signed-in");
            eprintln!(
                "{backend}: version {}, {} live models",
                caps.version.unwrap(),
                catalog.len()
            );
        }
    }

    #[test]
    fn probes_are_time_and_output_bounded() {
        assert!(
            run_bounded("/bin/sh", &["-c", "sleep 5"], Duration::from_millis(50))
                .unwrap_err()
                .contains("timed out")
        );
        let output =
            run_bounded("/bin/sh", &["-c", "printf hello"], Duration::from_secs(1)).unwrap();
        assert_eq!(output.stdout, "hello");
        assert!(run_bounded("/bin/sh", &["-c", "yes x"], Duration::from_secs(1)).is_err());
    }
}

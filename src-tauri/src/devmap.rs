// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Localhost dashboard's backend: "what dev servers do I have up, and from
//! which repos?"
//!
//! One scan answers that from three subprocess spawns and nothing else. The
//! spawn budget is the design constraint — the surface polls every few seconds
//! while it is visible, so a per-pid `lsof`/`ps` would mean dozens of forks a
//! tick. Instead we take one listener sweep and then two BATCHED lookups over
//! the pids that sweep found:
//!
//!   1. `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`  → who is listening, on what port
//!   2. `lsof -a -p <pids> -d cwd -Fpn`      → each listener's cwd
//!   3. `ps -o pid=,args= -p <pids>`         → each listener's command line
//!
//! Everything after that is pure: mapping a cwd to one of the user's known
//! projects, reading a project root once to name its stack, and deriving the
//! command that would bring the server back. The pure functions carry the
//! tests; the command is thin glue over them.
//!
//! A listener that doesn't map to a project is not a dev server — it's
//! `rapportd`, Chrome's helper, a database. Those land in a compact `others`
//! list with zero enrichment cost, because paying a filesystem probe for them
//! is what would make the poll expensive.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::db::Database;
use crate::state::SessionStore;

/// Redline's own daemon port — never a card.
const DAEMON_PORT: u16 = 7676;
/// How many non-project listeners we bother reporting.
const MAX_OTHERS: usize = 64;
/// How many remembered (not-currently-running) servers a scan returns.
const MAX_RECENT: i64 = 24;
/// How many rows the table keeps at all.
const KEEP_ROWS: i64 = 50;
/// How far up from a listener's cwd we look for its project root.
const MAX_WALK_UP: usize = 6;

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

/// One `(pid, port)` a listener sweep found, with the process's short command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawListener {
    pub pid: u32,
    pub comm: String,
    pub port: u16,
}

/// The port out of an `lsof -F n` name field: everything after the LAST colon.
/// Handles every shape a listening socket takes — `*:5173`, `127.0.0.1:5173`,
/// `[::1]:5173` — without a special case per form.
fn port_from_lsof_name(name: &str) -> Option<u16> {
    let (_, port) = name.trim().rsplit_once(':')?;
    port.parse().ok()
}

/// Listeners out of `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`.
///
/// `-F` streams a process set (`p<pid>`, `c<command>`) followed by one `n` line
/// per matching file, so the current pid/command is simply whatever was seen
/// last. A process listening on both IPv4 and IPv6 (or holding several fds on
/// one port) emits several identical `n` lines, so `(pid, port)` is deduped —
/// otherwise every Vite server would appear two or three times.
pub fn parse_lsof_listeners(output: &str, own_pid: u32) -> Vec<RawListener> {
    let mut out = Vec::new();
    let mut seen: HashSet<(u32, u16)> = HashSet::new();
    let mut pid: Option<u32> = None;
    let mut comm = String::new();
    for line in output.lines() {
        if let Some(v) = line.strip_prefix('p') {
            pid = v.trim().parse().ok();
            comm.clear();
        } else if let Some(v) = line.strip_prefix('c') {
            comm = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix('n') {
            let Some(pid) = pid else { continue };
            // Our own listeners are not somebody's dev server, and neither is
            // the daemon port every Redline install holds open.
            if pid == own_pid || pid <= 1 {
                continue;
            }
            let Some(port) = port_from_lsof_name(v) else {
                continue;
            };
            if port == DAEMON_PORT {
                continue;
            }
            if seen.insert((pid, port)) {
                out.push(RawListener {
                    pid,
                    comm: comm.clone(),
                    port,
                });
            }
        }
    }
    out
}

/// Working directories out of a batched `lsof -a -p <pids> -d cwd -Fpn`.
pub fn parse_lsof_cwds(output: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    let mut pid: Option<u32> = None;
    for line in output.lines() {
        if let Some(v) = line.strip_prefix('p') {
            pid = v.trim().parse().ok();
        } else if let Some(v) = line.strip_prefix('n') {
            let path = v.trim();
            if let (Some(pid), false) = (pid, path.is_empty()) {
                out.entry(pid).or_insert_with(|| path.to_string());
            }
        }
    }
    out
}

/// Command lines out of a batched `ps -o pid=,args= -p <pids>`. Each line is
/// leading-space-padded `<pid> <args…>`; args may contain anything, so we split
/// exactly once.
pub fn parse_ps_args(output: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    for line in output.lines() {
        let trimmed = line.trim_start();
        let Some((pid, args)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        let args = args.trim();
        if !args.is_empty() {
            out.insert(pid, args.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Project mapping (pure)
// ---------------------------------------------------------------------------

/// Trailing-slash-insensitive form, so `/repo` and `/repo/` are one project.
fn normalize_path(p: &str) -> String {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        "/".to_string()
    } else {
        t.to_string()
    }
}

/// System and package-manager trees. A `.git` or `package.json` down one of
/// these is somebody else's, not a project the user is developing.
const SYSTEM_PREFIXES: [&str; 10] = [
    "/usr", "/opt", "/Library", "/System", "/Applications", "/private", "/bin",
    "/sbin", "/var", "/nix",
];

/// Could this directory plausibly be a project the user WORKS in?
///
/// Root markers alone are far too generous, and a live scan proves it: Homebrew
/// keeps a `.git` in `/opt/homebrew`, every VS Code extension ships a
/// `package.json`, and plenty of people have a dotfiles repo in `$HOME`. Without
/// this filter, postgres files under "/opt/homebrew", a language server under
/// "~/.vscode/extensions/…", and anything at all launched from the home
/// directory all arrive as rich project cards — and the dashboard's one job is
/// to show the user's repos.
///
/// So four exclusions, each for a failure mode actually observed:
///   * the home directory itself (and `/`, `/Users`) — where you land, not a project
///   * system/package-manager trees
///   * any dot-directory below home (`~/.vscode`, `~/.cargo`, `~/.local`)
///   * anything inside a `node_modules`
pub fn is_plausible_project_root(dir: &Path, home: Option<&str>) -> bool {
    let path = normalize_path(&dir.to_string_lossy());
    if path == "/" || path == "/Users" || path == "/home" {
        return false;
    }
    if let Some(home) = home {
        let home = normalize_path(home);
        if path == home {
            return false;
        }
        // A dot-directory anywhere below home.
        if let Some(rest) = path.strip_prefix(&format!("{home}/")) {
            if rest.split('/').any(|seg| seg.starts_with('.')) {
                return false;
            }
        }
    }
    if SYSTEM_PREFIXES
        .iter()
        .any(|p| path == *p || path.starts_with(&format!("{p}/")))
    {
        return false;
    }
    if path.split('/').any(|seg| seg == "node_modules") {
        return false;
    }
    true
}

/// Which project a listener belongs to, given its cwd.
///
/// Walks up at most [`MAX_WALK_UP`] levels, over ancestors that pass
/// [`is_plausible_project_root`]. A directory the user has actually worked in
/// (Redline's project registry) wins over a root marker at ANY depth: a server
/// started from `myapp/packages/web` in a repo the user reviews plans for should
/// say "myapp", not "web", even though `packages/web` has its own
/// `package.json`. Only when no ancestor is a known project do we fall back to
/// the nearest marker directory.
///
/// `has_marker` is injected so the walk is testable without touching a disk.
pub fn resolve_project(
    cwd: &str,
    known: &HashSet<String>,
    home: Option<&str>,
    has_marker: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let start = PathBuf::from(cwd);
    let ancestors: Vec<&Path> = start
        .ancestors()
        .take(MAX_WALK_UP + 1)
        .filter(|d| is_plausible_project_root(d, home))
        .collect();
    for dir in &ancestors {
        if known.contains(&normalize_path(&dir.to_string_lossy())) {
            return Some(dir.to_path_buf());
        }
    }
    for dir in &ancestors {
        if has_marker(dir) {
            return Some(dir.to_path_buf());
        }
    }
    None
}

/// The four "this is a project root" files, checked on disk.
pub fn dir_has_root_marker(dir: &Path) -> bool {
    const MARKERS: [&str; 4] = [".git", "package.json", "Cargo.toml", "pyproject.toml"];
    MARKERS.iter().any(|m| dir.join(m).exists())
}

// ---------------------------------------------------------------------------
// Project probe + stack/command derivation (pure over the probe)
// ---------------------------------------------------------------------------

/// Everything we read off a project root, in ONE filesystem pass. Memoized per
/// scan so a repo running three servers is probed once, not three times.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectProbe {
    pub dir_name: String,
    pub has_package_json: bool,
    pub pkg_name: Option<String>,
    /// Union of dependencies + devDependencies (names only).
    pub deps: HashSet<String>,
    /// Script names only — the bodies never reach a shell, we re-derive them.
    pub scripts: HashSet<String>,
    pub has_cargo_toml: bool,
    pub cargo_name: Option<String>,
    pub has_pyproject: bool,
    pub has_manage_py: bool,
    /// `"pnpm-lock.yaml"` / `"yarn.lock"` / `"bun.lockb"` / `"package-lock.json"`.
    pub lockfile: Option<String>,
}

/// Read a project root. Best-effort throughout: an unreadable or malformed file
/// simply leaves its fields empty (a dashboard card is never worth an error).
pub fn probe_project(root: &Path) -> ProjectProbe {
    let mut probe = ProjectProbe {
        dir_name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        ..Default::default()
    };
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        probe.has_package_json = true;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            probe.pkg_name = v
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            for key in ["dependencies", "devDependencies"] {
                if let Some(map) = v.get(key).and_then(|d| d.as_object()) {
                    probe.deps.extend(map.keys().cloned());
                }
            }
            if let Some(map) = v.get("scripts").and_then(|s| s.as_object()) {
                probe.scripts.extend(map.keys().cloned());
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(root.join("Cargo.toml")) {
        probe.has_cargo_toml = true;
        probe.cargo_name = cargo_package_name(&text);
    }
    probe.has_pyproject = root.join("pyproject.toml").exists();
    probe.has_manage_py = root.join("manage.py").exists();
    probe.lockfile = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "package-lock.json"]
        .into_iter()
        .find(|f| root.join(f).exists())
        .map(|f| f.to_string());
    probe
}

/// `name = "foo"` out of Cargo.toml's `[package]` section, without pulling in a
/// TOML parser for one field.
fn cargo_package_name(text: &str) -> Option<String> {
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        if let Some(rest) = line.strip_prefix("name") {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// The runtime a server belongs to. Used to tell "the process agrees with the
/// project" from "this repo is running something else on this port".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Node,
    Python,
    Rust,
    Ruby,
    /// A project root with no manifest we recognize.
    Unknown,
}

/// The runtime a project's own manifests imply.
pub fn probe_family(p: &ProjectProbe) -> Family {
    if p.has_package_json {
        Family::Node
    } else if p.has_manage_py || p.has_pyproject {
        Family::Python
    } else if p.has_cargo_toml {
        Family::Rust
    } else {
        Family::Unknown
    }
}

/// Runners we can name from a process's own command line, most specific first.
/// Bare interpreters (`node`, `python`) sit at the end: they identify a family
/// but no framework, and `node` in particular is far too common in argv to be
/// treated as a signal on its own — so it is deliberately absent.
const RUNNERS: [(&str, &str, Family); 17] = [
    ("next-server", "Next.js", Family::Node),
    ("next", "Next.js", Family::Node),
    ("nuxt", "Nuxt", Family::Node),
    ("astro", "Astro", Family::Node),
    ("remix-serve", "Remix", Family::Node),
    ("react-scripts", "CRA", Family::Node),
    ("vite", "Vite", Family::Node),
    ("manage.py", "Django", Family::Python),
    ("uvicorn", "Uvicorn", Family::Python),
    ("gunicorn", "Gunicorn", Family::Python),
    ("flask", "Flask", Family::Python),
    ("http.server", "Python", Family::Python),
    ("rails", "Rails", Family::Ruby),
    ("puma", "Puma", Family::Ruby),
    ("cargo", "Rust", Family::Rust),
    ("python", "Python", Family::Python),
    ("python3", "Python", Family::Python),
];

/// Which runner a process's command line names, if any.
///
/// Matching is on whole tokens (split on whitespace and path separators), never
/// substrings — otherwise a project living at `~/vite-experiments/api` would be
/// read as a Vite server.
pub fn detect_runner(comm: &str, args: &str) -> Option<(&'static str, Family)> {
    let haystack = format!("{comm} {args}").to_ascii_lowercase();
    let tokens: HashSet<&str> = haystack
        .split(|c: char| c.is_whitespace() || c == '/' || c == '\\')
        .filter(|t| !t.is_empty())
        .collect();
    RUNNERS
        .iter()
        .find(|(token, _, _)| tokens.contains(token))
        .map(|(_, label, family)| (*label, *family))
}

/// The succinct label a card leads with: `"Vite — myapp"`.
///
/// Framework beats bundler on purpose. A Next.js app has `vite` nowhere near it
/// but an Astro or Remix app may well carry `vite` as a transitive dev
/// dependency — reporting "Vite" for those would be technically true and
/// useless. So the specific frameworks are tested first and the bundler is the
/// consolation prize. With no probe at all (a non-project listener, or an
/// unreadable root) the process's own command is the honest answer.
pub fn detect_stack(probe: Option<&ProjectProbe>, comm: &str, args: &str) -> String {
    let Some(p) = probe else {
        return comm.to_string();
    };
    // A repo can run more than one server — a Next.js web app on :3000 and a
    // Python API on :8000 — and describing BOTH from the project's dependency
    // list labels them identically. So when the running process names a runtime
    // that disagrees with the project's own, the process wins: it is the more
    // specific evidence about what is actually listening on this port.
    //
    // Only a DISAGREEMENT overrides. Within the same family the probe is better
    // (package.json says "next" with certainty, where an argv token is a guess),
    // which also means a stray path segment like `~/next/myapp` can't mislabel
    // a project that isn't Next.
    let family = probe_family(p);
    if let Some((label, runner_family)) = detect_runner(comm, args) {
        if runner_family != family {
            let name = p
                .pkg_name
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| p.dir_name.clone());
            return format!("{label} — {name}");
        }
    }
    let name = p
        .pkg_name
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| p.dir_name.clone());
    let dep = |d: &str| p.deps.contains(d);
    let framework = if dep("next") {
        Some("Next.js")
    } else if dep("astro") {
        Some("Astro")
    } else if p.deps.iter().any(|d| d.starts_with("@remix-run/")) {
        Some("Remix")
    } else if dep("react-scripts") {
        Some("CRA")
    } else if dep("vite") {
        Some("Vite")
    } else if dep("express") {
        Some("Express")
    } else if p.has_package_json {
        Some("Node")
    } else {
        None
    };
    if let Some(f) = framework {
        return format!("{f} — {name}");
    }
    if p.has_manage_py {
        return format!("Django — {}", p.dir_name);
    }
    if p.has_pyproject {
        return format!("Python — {}", p.dir_name);
    }
    if p.has_cargo_toml {
        let n = p.cargo_name.clone().unwrap_or_else(|| p.dir_name.clone());
        return format!("Rust — {n}");
    }
    comm.to_string()
}

/// The package manager a repo's lockfile implies.
fn package_manager(lockfile: Option<&str>) -> &'static str {
    match lockfile {
        Some("pnpm-lock.yaml") => "pnpm",
        Some("yarn.lock") => "yarn",
        Some("bun.lockb") => "bun",
        _ => "npm",
    }
}

/// The command that would bring this server back.
///
/// Derived once, at record time, and STORED on the row — so a card for a server
/// that is no longer running still knows how to start it, and the tooltip can
/// show exactly what Run will type before the user commits to it. The raw
/// process args are the last resort: verbatim is at least always true, even
/// when it's `node /long/path/to/.bin/vite`.
pub fn derive_run_command(
    probe: Option<&ProjectProbe>,
    comm: &str,
    raw_args: &str,
) -> String {
    if let Some(p) = probe {
        // The project's dev script only restarts THIS process if this process is
        // the project's own server. For a Python API sharing a repo with a
        // Next.js app, `npm run dev` would start the wrong thing entirely — so
        // when the runtimes disagree, the process's own argv is the only
        // truthful answer, verbatim.
        let family = probe_family(p);
        if detect_runner(comm, raw_args).is_some_and(|(_, f)| f != family) {
            return raw_args.trim().to_string();
        }
        let pm = package_manager(p.lockfile.as_deref());
        if p.scripts.contains("dev") {
            return format!("{pm} run dev");
        }
        if p.scripts.contains("start") {
            return format!("{pm} run start");
        }
        if p.has_cargo_toml {
            return "cargo run".to_string();
        }
        if p.has_manage_py {
            return "python manage.py runserver".to_string();
        }
    }
    raw_args.trim().to_string()
}

// ---------------------------------------------------------------------------
// Scan output
// ---------------------------------------------------------------------------

/// A dev server that is listening right now, mapped to one of the user's repos.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningServer {
    pub pid: u32,
    /// The card's port: the lowest one this process holds.
    pub port: u16,
    /// Every other port the same process listens on (HMR sockets and friends).
    pub extra_ports: Vec<u16>,
    pub url: String,
    pub comm: String,
    pub args: String,
    pub project_path: String,
    pub project_name: String,
    pub stack: String,
    pub run_command: String,
    pub thumb_path: Option<String>,
}

/// A server we remember but that is not up right now.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentServer {
    pub id: i64,
    pub project_path: String,
    pub project_name: String,
    pub port: u16,
    pub url: String,
    pub stack: String,
    pub run_command: String,
    pub last_seen_at: i64,
    pub thumb_path: Option<String>,
    /// Something else holds this port now. Run is still offered (the dev server
    /// will pick the next free port, as they all do) — the hint just explains
    /// why the URL may not be the one that comes up.
    pub port_busy: bool,
}

/// A listener that isn't a project's dev server.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OtherListener {
    pub pid: u32,
    pub port: u16,
    pub comm: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevServerScan {
    pub running: Vec<RunningServer>,
    pub recent: Vec<RecentServer>,
    pub others: Vec<OtherListener>,
}

/// Split remembered rows into the ones worth showing as "recent": drop the ones
/// that are live right now (they already have a running card), drop the ones
/// whose project directory is gone, and flag the ones whose port a foreign
/// process has taken. Pure so the partition is testable; `dir_exists` is
/// injected.
pub fn partition_recent(
    rows: Vec<crate::db::DevServerRow>,
    live_keys: &HashSet<(String, u16)>,
    busy_ports: &HashSet<u16>,
    dir_exists: impl Fn(&str) -> bool,
) -> Vec<RecentServer> {
    rows.into_iter()
        .filter(|r| !live_keys.contains(&(normalize_path(&r.project_path), r.port)))
        .filter(|r| dir_exists(&r.project_path))
        .map(|r| RecentServer {
            port_busy: busy_ports.contains(&r.port),
            id: r.id,
            project_path: r.project_path,
            project_name: r.project_name,
            port: r.port,
            url: r.url,
            stack: r.stack,
            run_command: r.run_command,
            last_seen_at: r.last_seen_at,
            thumb_path: r.thumb_path,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn run_capture(program: &str, args: &[String]) -> Result<String, String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One sweep of the machine. See the module header for the spawn budget.
#[tauri::command(async)]
pub fn dev_servers_scan(
    store: tauri::State<'_, SessionStore>,
) -> Result<DevServerScan, String> {
    let db = store.database();
    scan_with(&db, std::process::id())
}

/// The scan body, with the process-id injected so tests can drive it.
fn scan_with(db: &Database, own_pid: u32) -> Result<DevServerScan, String> {
    // 1 — who is listening.
    let listeners_out = run_capture(
        "lsof",
        &[
            "-nP".into(),
            "-iTCP".into(),
            "-sTCP:LISTEN".into(),
            "-Fpcn".into(),
        ],
    )?;
    let listeners = parse_lsof_listeners(&listeners_out, own_pid);

    // Group ports per pid up front: one process is ONE card, so a Vite dev
    // server's HMR socket can't mint a second one.
    let mut by_pid: HashMap<u32, (String, Vec<u16>)> = HashMap::new();
    for l in &listeners {
        let e = by_pid
            .entry(l.pid)
            .or_insert_with(|| (l.comm.clone(), Vec::new()));
        e.1.push(l.port);
    }
    for (_, ports) in by_pid.values_mut() {
        ports.sort_unstable();
    }
    let pids: Vec<u32> = {
        let mut v: Vec<u32> = by_pid.keys().copied().collect();
        v.sort_unstable();
        v
    };

    // 2 + 3 — batched cwd and args for exactly those pids.
    let (cwds, args_by_pid) = if pids.is_empty() {
        (HashMap::new(), HashMap::new())
    } else {
        let list = pids
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let cwd_out = run_capture(
            "lsof",
            &[
                "-a".into(),
                "-p".into(),
                list.clone(),
                "-d".into(),
                "cwd".into(),
                "-Fpn".into(),
            ],
        )
        .unwrap_or_default();
        let ps_out = run_capture(
            "ps",
            &["-o".into(), "pid=,args=".into(), "-p".into(), list],
        )
        .unwrap_or_default();
        (parse_lsof_cwds(&cwd_out), parse_ps_args(&ps_out))
    };

    let known: HashSet<String> = db
        .list_project_paths()
        .unwrap_or_default()
        .iter()
        .map(|p| normalize_path(p))
        .collect();

    let home = std::env::var("HOME").ok();
    let mut probes: HashMap<PathBuf, ProjectProbe> = HashMap::new();
    let mut running: Vec<RunningServer> = Vec::new();
    let mut others: Vec<OtherListener> = Vec::new();
    let now = crate::ledger::now_millis();

    for pid in &pids {
        let Some((comm, ports)) = by_pid.get(pid) else {
            continue;
        };
        let Some(port) = ports.first().copied() else {
            continue;
        };
        let root = cwds.get(pid).and_then(|cwd| {
            resolve_project(cwd, &known, home.as_deref(), dir_has_root_marker)
        });
        let Some(root) = root else {
            // Not a project — a compact row, and crucially no filesystem probe.
            if others.len() < MAX_OTHERS {
                others.push(OtherListener {
                    pid: *pid,
                    port,
                    comm: comm.clone(),
                });
            }
            continue;
        };
        let probe = probes
            .entry(root.clone())
            .or_insert_with(|| probe_project(&root));
        let args = args_by_pid.get(pid).cloned().unwrap_or_default();
        let stack = detect_stack(Some(probe), comm, &args);
        let run_command = derive_run_command(Some(probe), comm, &args);
        let project_path = normalize_path(&root.to_string_lossy());
        let project_name = probe.dir_name.clone();
        let url = format!("http://localhost:{port}");

        let _ = db.upsert_dev_server(
            &project_path,
            &project_name,
            port,
            &url,
            &stack,
            &run_command,
            Some(*pid),
            Some(args.as_str()).filter(|a| !a.is_empty()),
            now,
        );

        running.push(RunningServer {
            pid: *pid,
            port,
            extra_ports: ports[1..].to_vec(),
            url,
            comm: comm.clone(),
            args,
            project_path,
            project_name,
            stack,
            run_command,
            thumb_path: None,
        });
    }
    running.sort_by(|a, b| a.port.cmp(&b.port));
    others.sort_by(|a, b| a.port.cmp(&b.port));

    let _ = db.prune_dev_servers(KEEP_ROWS);
    let rows = db.list_dev_servers(MAX_RECENT * 2).unwrap_or_default();
    // Carry each running card's stored thumbnail across (the row is the durable
    // home of a capture; the scan itself has no image state).
    let thumbs: HashMap<(String, u16), Option<String>> = rows
        .iter()
        .map(|r| {
            (
                (normalize_path(&r.project_path), r.port),
                r.thumb_path.clone(),
            )
        })
        .collect();
    for r in running.iter_mut() {
        if let Some(t) = thumbs.get(&(r.project_path.clone(), r.port)) {
            r.thumb_path = t.clone();
        }
    }

    let live_keys: HashSet<(String, u16)> = running
        .iter()
        .map(|r| (r.project_path.clone(), r.port))
        .collect();
    let busy_ports: HashSet<u16> = listeners.iter().map(|l| l.port).collect();
    let mut recent = partition_recent(rows, &live_keys, &busy_ports, |p| {
        Path::new(p).is_dir()
    });
    recent.truncate(MAX_RECENT as usize);

    Ok(DevServerScan {
        running,
        recent,
        others,
    })
}

/// Remember a freshly-captured thumbnail against its card's row, so the picture
/// outlives the process it depicts: stop the server and the card keeps showing
/// what it was serving.
#[tauri::command(async)]
pub fn dev_server_set_thumb(
    store: tauri::State<'_, SessionStore>,
    project_path: String,
    port: u16,
    path: String,
) -> Result<(), String> {
    store
        .database()
        .set_dev_server_thumb(&normalize_path(&project_path), port, &path)
        .map_err(|e| e.to_string())
}

/// Stop a running dev server.
///
/// The pid came from a scan that may be seconds old, and pids get reused — so
/// before signalling anything we re-read the process's command and require it
/// to match verbatim what the card was showing. A mismatch is an error, never a
/// stray `SIGTERM` at whatever now owns that pid. `TERM` (not `KILL`) so the
/// server runs its own shutdown, and via `/bin/kill` so this stays dependency-free
/// like the neighbouring `ps`/`lsof` calls.
#[tauri::command(async)]
pub fn dev_server_stop(
    store: tauri::State<'_, SessionStore>,
    pid: u32,
    expected_comm: String,
    project_path: Option<String>,
) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() {
        return Err("that process can't be stopped from here".into());
    }
    let actual = crate::current_comm(pid);
    if actual.as_deref() != Some(expected_comm.as_str()) {
        return Err("that process already exited".into());
    }
    let out = std::process::Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .output()
        .map_err(|e| format!("kill: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let _ = store.database().append_journal(
        "dev_server_stop",
        Some("servers"),
        Some(&pid.to_string()),
        Some(&expected_comm),
        project_path.as_deref(),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry as `scan_with` hands it over: normalized on the way in, so
    /// `resolve_project` compares two canonical forms and never pays a
    /// per-lookup allocation.
    const HOME: Option<&str> = Some("/Users/me");

    fn known(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| normalize_path(p)).collect()
    }

    #[test]
    fn listeners_collapse_ipv4_and_ipv6_rows_for_one_port() {
        let out = "p100\ncnode\nn*:5173\nn127.0.0.1:5173\nn[::1]:5173\n";
        let got = parse_lsof_listeners(out, 1);
        assert_eq!(
            got,
            vec![RawListener {
                pid: 100,
                comm: "node".into(),
                port: 5173
            }]
        );
    }

    #[test]
    fn listeners_keep_distinct_ports_of_one_process() {
        let out = "p100\ncnode\nn*:5173\nn*:24678\n";
        let ports: Vec<u16> = parse_lsof_listeners(out, 1)
            .into_iter()
            .map(|l| l.port)
            .collect();
        assert_eq!(ports, vec![5173, 24678]);
    }

    #[test]
    fn listeners_drop_our_own_pid_and_the_daemon_port() {
        let out = "p42\ncredline\nn*:7676\np100\ncnode\nn*:7676\np101\ncnode\nn*:3000\n";
        let got = parse_lsof_listeners(out, 42);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].pid, 101);
        assert_eq!(got[0].port, 3000);
    }

    #[test]
    fn listeners_survive_garbage_and_orphan_name_lines() {
        // A name line before any process line, an unparseable port, and a
        // field we never asked for must all be skipped, not panic.
        let out = "n*:9999\nfoo\np100\ncnode\nnsomething-with-no-colon\nn*:abc\nn*:3000\n";
        let got = parse_lsof_listeners(out, 1);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].port, 3000);
    }

    #[test]
    fn cwds_and_args_parse_from_batched_output() {
        let cwds = parse_lsof_cwds("p100\nn/Users/me/app\np200\nn/tmp\n");
        assert_eq!(cwds.get(&100).map(String::as_str), Some("/Users/me/app"));
        assert_eq!(cwds.get(&200).map(String::as_str), Some("/tmp"));

        let args = parse_ps_args("  100 node /a/b/vite --host\n 200 python manage.py runserver\n");
        assert_eq!(args.get(&100).map(String::as_str), Some("node /a/b/vite --host"));
        assert_eq!(
            args.get(&200).map(String::as_str),
            Some("python manage.py runserver")
        );
    }

    #[test]
    fn a_known_project_beats_a_nearer_root_marker() {
        // The monorepo package has its own package.json, but the user's
        // registry knows the repo root — the card should say the repo.
        let got = resolve_project(
            "/Users/me/myapp/packages/web",
            &known(&["/Users/me/myapp"]),
            HOME,
            |p| p.ends_with("web"),
        );
        assert_eq!(got, Some(PathBuf::from("/Users/me/myapp")));
    }

    #[test]
    fn root_markers_resolve_the_nearest_directory_when_nothing_is_known() {
        let got = resolve_project(
            "/Users/me/scratch/thing/src",
            &known(&[]),
            HOME,
            |p| p == Path::new("/Users/me/scratch/thing"),
        );
        assert_eq!(got, Some(PathBuf::from("/Users/me/scratch/thing")));
    }

    #[test]
    fn the_walk_up_is_depth_bounded() {
        // Eight levels down: the marker at the root is out of reach, so this
        // listener is simply not project-mapped rather than mis-attributed.
        let deep = "/a/b/c/d/e/f/g/h";
        assert_eq!(
            resolve_project(deep, &known(&[]), HOME, |p| p == Path::new("/a")),
            None
        );
        assert_eq!(
            resolve_project(deep, &known(&["/a"]), HOME, |_| false),
            None,
            "a known path further up than the bound is also out of reach"
        );
    }

    #[test]
    fn junk_roots_are_not_projects() {
        // Every one of these was observed on a live scan producing a rich
        // "dev server" card it had no business producing.
        for junk in [
            "/",
            "/Users",
            "/Users/me",                                  // the home dir itself
            "/opt/homebrew",                              // Homebrew keeps a .git
            "/usr/local/share/thing",
            "/Applications/Some.app/Contents",
            "/Library/Whatever",
            "/Users/me/.vscode/extensions/ms-python.foo", // extensions ship package.json
            "/Users/me/.cargo/registry/src/x",
            "/Users/me/app/node_modules/some-dep",
        ] {
            assert!(
                !is_plausible_project_root(Path::new(junk), HOME),
                "{junk} must not be treated as a project"
            );
        }
        for real in [
            "/Users/me/app",
            "/Users/me/code/clients/acme",
            "/Users/me/dot.files/app", // a dot INSIDE a name is not a dotdir
            "/srv/deploy/app",
        ] {
            assert!(
                is_plausible_project_root(Path::new(real), HOME),
                "{real} is a legitimate project root"
            );
        }
    }

    #[test]
    fn a_junk_ancestor_never_captures_a_real_project() {
        // A server started in ~/.vscode/... must fall through to "not a
        // project" rather than being attributed to the home directory.
        assert_eq!(
            resolve_project("/Users/me/.vscode/extensions/x", &known(&[]), HOME, |_| true),
            None,
        );
        // Even if the home directory is in the registry (a plan session that
        // launched in $HOME — a real thing that has happened), it must not
        // become every listener's project.
        assert_eq!(
            resolve_project("/Users/me/random/dir", &known(&["/Users/me"]), HOME, |_| false),
            None,
        );
        // But a real repo below home still resolves.
        assert_eq!(
            resolve_project("/Users/me/app/src", &known(&["/Users/me/app"]), HOME, |_| false),
            Some(PathBuf::from("/Users/me/app")),
        );
    }

    #[test]
    fn trailing_slashes_do_not_split_a_project() {
        // `sessions.project_path` rows are user-supplied strings, so the same
        // repo can be recorded both ways. Normalizing at the boundary is what
        // keeps that from minting two projects for one directory.
        assert_eq!(normalize_path("/Users/me/app/"), "/Users/me/app");
        assert_eq!(normalize_path("/"), "/", "the root survives normalization");
        let got =
            resolve_project("/Users/me/app", &known(&["/Users/me/app/"]), HOME, |_| false);
        assert_eq!(got, Some(PathBuf::from("/Users/me/app")));
    }

    fn probe_with(deps: &[&str], scripts: &[&str]) -> ProjectProbe {
        ProjectProbe {
            dir_name: "myapp".into(),
            has_package_json: true,
            pkg_name: Some("myapp".into()),
            deps: deps.iter().map(|d| d.to_string()).collect(),
            scripts: scripts.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_framework_beats_the_bundler() {
        // Both present (Astro ships Vite) — the useful label is the framework.
        let p = probe_with(&["vite", "astro"], &[]);
        assert_eq!(detect_stack(Some(&p), "node", ""), "Astro — myapp");
        let p = probe_with(&["vite", "next"], &[]);
        assert_eq!(detect_stack(Some(&p), "node", ""), "Next.js — myapp");
    }

    #[test]
    fn each_framework_gets_its_own_label() {
        for (dep, label) in [
            ("next", "Next.js"),
            ("astro", "Astro"),
            ("@remix-run/node", "Remix"),
            ("react-scripts", "CRA"),
            ("vite", "Vite"),
            ("express", "Express"),
        ] {
            let p = probe_with(&[dep], &[]);
            assert_eq!(detect_stack(Some(&p), "node", ""), format!("{label} — myapp"));
        }
        // A package.json with nothing recognizable still beats a bare comm.
        let p = probe_with(&["lodash"], &[]);
        assert_eq!(detect_stack(Some(&p), "node", ""), "Node — myapp");
    }

    #[test]
    fn stack_falls_back_through_python_rust_and_finally_the_command() {
        let django = ProjectProbe {
            dir_name: "site".into(),
            has_manage_py: true,
            has_pyproject: true,
            ..Default::default()
        };
        assert_eq!(detect_stack(Some(&django), "python3", ""), "Django — site");

        let py = ProjectProbe {
            dir_name: "site".into(),
            has_pyproject: true,
            ..Default::default()
        };
        assert_eq!(detect_stack(Some(&py), "python3", ""), "Python — site");

        let rs = ProjectProbe {
            dir_name: "dir".into(),
            has_cargo_toml: true,
            cargo_name: Some("server".into()),
            ..Default::default()
        };
        assert_eq!(detect_stack(Some(&rs), "server", ""), "Rust — server");

        assert_eq!(detect_stack(None, "rapportd", ""), "rapportd");
    }

    #[test]
    fn a_second_runtime_in_one_repo_gets_its_own_label_and_command() {
        // The case the whole runner check exists for: a Next.js web app and a
        // Python API out of the SAME repo. Describing both from package.json
        // gives two identical cards, and Run on the API would start the web app.
        let repo = probe_with(&["next"], &["dev"]);
        let web = "next-server (v16.2.6)";
        let api = "python3 -m uvicorn app:main --port 8000";

        assert_eq!(detect_stack(Some(&repo), "node", web), "Next.js — myapp");
        assert_eq!(detect_stack(Some(&repo), "Python", api), "Uvicorn — myapp");

        assert_eq!(derive_run_command(Some(&repo), "node", web), "npm run dev");
        assert_eq!(
            derive_run_command(Some(&repo), "Python", api),
            api,
            "the project's dev script would start the wrong server entirely"
        );
    }

    #[test]
    fn within_one_family_the_project_manifest_still_wins() {
        // The runner only breaks ties ACROSS runtimes. Inside a family the
        // dependency list is the better evidence — and this is what stops a
        // project living at ~/next/myapp from being mislabeled "Next.js".
        let vite_app = probe_with(&["vite"], &["dev"]);
        assert_eq!(
            detect_stack(Some(&vite_app), "node", "node /Users/me/next/myapp/x"),
            "Vite — myapp",
        );
    }

    #[test]
    fn runners_are_matched_as_whole_tokens_never_substrings() {
        assert_eq!(detect_runner("node", "node /a/vite-experiments/api.js"), None);
        assert_eq!(
            detect_runner("node", "node /a/node_modules/.bin/vite dev"),
            Some(("Vite", Family::Node)),
        );
        assert_eq!(
            detect_runner("Python", "/opt/x/MacOS/Python -m http.server 5199"),
            Some(("Python", Family::Python)),
        );
        assert_eq!(
            detect_runner("python", "python manage.py runserver"),
            Some(("Django", Family::Python)),
            "the most specific runner wins over the bare interpreter",
        );
        // A bare `node` is far too common in argv to mean anything on its own.
        assert_eq!(detect_runner("node", "node server.js"), None);
    }

    #[test]
    fn probe_family_reads_the_manifests() {
        assert_eq!(probe_family(&probe_with(&[], &[])), Family::Node);
        assert_eq!(
            probe_family(&ProjectProbe { has_pyproject: true, ..Default::default() }),
            Family::Python,
        );
        assert_eq!(
            probe_family(&ProjectProbe { has_cargo_toml: true, ..Default::default() }),
            Family::Rust,
        );
        assert_eq!(probe_family(&ProjectProbe::default()), Family::Unknown);
    }

    #[test]
    fn the_package_name_falls_back_to_the_directory_name() {
        let mut p = probe_with(&["vite"], &[]);
        p.pkg_name = None;
        assert_eq!(detect_stack(Some(&p), "node", ""), "Vite — myapp");
    }

    #[test]
    fn cargo_package_name_reads_only_the_package_section() {
        let toml = "[dependencies]\nname = \"wrong\"\n\n[package]\nname = \"right\"\n";
        assert_eq!(cargo_package_name(toml), Some("right".into()));
        assert_eq!(cargo_package_name("[package]\nversion = \"1\"\n"), None);
    }

    #[test]
    fn run_command_prefers_dev_and_follows_the_lockfile() {
        for (lock, pm) in [
            (Some("pnpm-lock.yaml"), "pnpm"),
            (Some("yarn.lock"), "yarn"),
            (Some("bun.lockb"), "bun"),
            (Some("package-lock.json"), "npm"),
            (None, "npm"),
        ] {
            let mut p = probe_with(&[], &["dev", "start"]);
            p.lockfile = lock.map(|l| l.to_string());
            assert_eq!(derive_run_command(Some(&p), "node", "node x"), format!("{pm} run dev"));
        }
    }

    #[test]
    fn run_command_falls_through_start_cargo_manage_then_raw_args() {
        let p = probe_with(&[], &["start"]);
        assert_eq!(derive_run_command(Some(&p), "node", "node x"), "npm run start");

        let rs = ProjectProbe {
            has_cargo_toml: true,
            ..Default::default()
        };
        assert_eq!(derive_run_command(Some(&rs), "node", "target/debug/x"), "cargo run");

        let dj = ProjectProbe {
            has_manage_py: true,
            ..Default::default()
        };
        assert_eq!(
            derive_run_command(Some(&dj), "node", "python x"),
            "python manage.py runserver"
        );

        let bare = ProjectProbe::default();
        assert_eq!(
            derive_run_command(Some(&bare), "node", "  ./serve --port 9000 "),
            "./serve --port 9000"
        );
        assert_eq!(derive_run_command(None, "sh", "./serve"), "./serve");
    }

    fn row(id: i64, path: &str, port: u16) -> crate::db::DevServerRow {
        crate::db::DevServerRow {
            id,
            project_path: path.into(),
            project_name: "app".into(),
            port,
            url: format!("http://localhost:{port}"),
            stack: "Vite — app".into(),
            run_command: "npm run dev".into(),
            last_seen_at: 1,
            thumb_path: None,
        }
    }

    #[test]
    fn recent_drops_live_rows_and_missing_directories_and_flags_busy_ports() {
        let rows = vec![
            row(1, "/a", 5173), // live right now → not "recent"
            row(2, "/a", 3000), // same repo, other port → recent
            row(3, "/gone", 8080), // directory no longer exists → dropped
            row(4, "/b", 4000), // port squatted by a foreign process
        ];
        let live: HashSet<(String, u16)> = [("/a".to_string(), 5173u16)].into_iter().collect();
        let busy: HashSet<u16> = [5173, 4000].into_iter().collect();
        let got = partition_recent(rows, &live, &busy, |p| p != "/gone");
        assert_eq!(
            got.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![2, 4],
            "{got:?}"
        );
        assert!(!got[0].port_busy);
        assert!(got[1].port_busy, "a foreign listener on 4000 is flagged");
    }

    #[test]
    fn upsert_keeps_first_seen_and_the_thumbnail_across_rescans() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_dev_server("/a", "a", 5173, "http://localhost:5173", "Vite — a", "npm run dev", Some(1), Some("node x"), 1_000)
            .unwrap();
        let id = db.list_dev_servers(10).unwrap()[0].id;
        db.set_dev_server_thumb("/a", 5173, "/thumbs/p5173-abc.png")
            .unwrap();
        // A later scan sees the same server with a churned run command.
        db.upsert_dev_server("/a", "a", 5173, "http://localhost:5173", "Vite — a", "pnpm run dev", Some(2), Some("node y"), 2_000)
            .unwrap();
        let rows = db.list_dev_servers(10).unwrap();
        assert_eq!(rows.len(), 1, "the (path, port) key is the same server");
        assert_eq!(rows[0].run_command, "pnpm run dev");
        assert_eq!(rows[0].last_seen_at, 2_000);
        assert_eq!(
            rows[0].thumb_path.as_deref(),
            Some("/thumbs/p5173-abc.png"),
            "a rescan must never blank a captured thumbnail"
        );
        assert_eq!(
            db.dev_server_first_seen(id).unwrap(),
            1_000,
            "first_seen_at is written once"
        );
    }

    /// Exercises the three real subprocess invocations against this machine.
    ///
    /// The unit tests above all feed the parsers canned strings, which cannot
    /// catch the likeliest regression by far: a wrong flag. `lsof` rejects an
    /// unknown option with empty stdout and a non-zero status, and every
    /// downstream parser would cheerfully return nothing — a permanently empty
    /// dashboard with no error anywhere. So assert on the SHAPE of a live scan,
    /// never on what happens to be running.
    #[test]
    fn a_live_scan_runs_the_real_commands_and_returns_a_coherent_shape() {
        if std::process::Command::new("lsof").arg("-v").output().is_err() {
            return; // no lsof on this box — nothing to assert
        }
        let db = Database::open_in_memory().unwrap();
        let scan = scan_with(&db, std::process::id()).expect("a live scan must not error");

        // Something on a dev machine is always listening (launchd, at minimum),
        // so a completely empty sweep means the flags stopped matching.
        assert!(
            !scan.running.is_empty() || !scan.others.is_empty(),
            "no listeners at all — the lsof invocation is probably wrong"
        );
        assert!(scan.others.len() <= MAX_OTHERS);
        assert!(scan.recent.len() <= MAX_RECENT as usize);

        let own = std::process::id();
        for o in &scan.others {
            assert_ne!(o.pid, own);
            assert_ne!(o.port, DAEMON_PORT);
        }
        let mut seen_pids = HashSet::new();
        for r in &scan.running {
            assert_ne!(r.pid, own);
            assert_ne!(r.port, DAEMON_PORT);
            assert!(seen_pids.insert(r.pid), "one process must be exactly one card");
            assert!(!r.project_path.is_empty(), "a running card is project-mapped");
            assert!(!r.project_name.is_empty());
            assert!(!r.stack.is_empty());
            assert_eq!(r.url, format!("http://localhost:{}", r.port));
            assert!(
                r.extra_ports.iter().all(|p| *p > r.port),
                "the primary port is the lowest one the process holds"
            );
        }
        // Every running card was recorded, and never also listed as "recent".
        let rows = db.list_dev_servers(100).unwrap();
        assert_eq!(rows.len(), scan.running.len());
        for r in &scan.running {
            assert!(
                !scan.recent.iter().any(|x| x.project_path == r.project_path
                    && x.port == r.port),
                "a live server must not also appear as recently-run"
            );
        }
    }

    #[test]
    fn prune_keeps_the_most_recent_rows() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..60u16 {
            db.upsert_dev_server(
                "/a",
                "a",
                3000 + i,
                "u",
                "s",
                "c",
                None,
                None,
                1_000 + i as i64,
            )
            .unwrap();
        }
        db.prune_dev_servers(50).unwrap();
        let rows = db.list_dev_servers(100).unwrap();
        assert_eq!(rows.len(), 50);
        assert_eq!(rows[0].port, 3059, "newest survives");
        assert!(rows.iter().all(|r| r.port >= 3010));
    }
}




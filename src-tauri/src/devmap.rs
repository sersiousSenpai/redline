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
/// First port of the OS's ephemeral range. A server the kernel handed a port
/// cannot be brought back AT that port, so remembering the row would offer a
/// Run button pointing at a URL that will never come up again — and the port
/// itself says nothing about what ran there. Such servers still show as
/// running cards while they are up; they are simply not worth remembering.
const EPHEMERAL_PORT_FLOOR: u16 = 49152;

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
    parse_listener_fields(output, Some(own_pid))
}

fn parse_listener_fields(output: &str, own_pid: Option<u32>) -> Vec<RawListener> {
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
            if Some(pid) == own_pid || pid <= 1 {
                continue;
            }
            let Some(port) = port_from_lsof_name(v) else {
                continue;
            };
            if own_pid.is_some() && port == DAEMON_PORT {
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
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        let args = args.trim();
        if !args.is_empty() {
            out.insert(pid, args.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Stop planning (pure, with all process facts injected)
// ---------------------------------------------------------------------------

const MAX_CLIMB: usize = 6;
/// Refuse an unexpectedly broad tree instead of silently stopping half of it.
const MAX_STOP_PIDS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcRow {
    pub ppid: u32,
    pub comm: String,
}

pub fn parse_ps_tree(output: &str) -> HashMap<u32, ProcRow> {
    output
        .lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let (ppid, comm) = rest.trim_start().split_once(char::is_whitespace)?;
            let comm = comm.trim();
            if comm.is_empty() {
                return None;
            }
            Some((
                pid.parse().ok()?,
                ProcRow {
                    ppid: ppid.parse().ok()?,
                    comm: comm.into(),
                },
            ))
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopPlan {
    pub root: u32,
    pub root_label: String,
    pub pids: Vec<u32>,
    pub collateral_ports: Vec<u16>,
}

fn protected_processes(own_pid: u32, procs: &HashMap<u32, ProcRow>) -> HashSet<u32> {
    let mut protected = HashSet::from([0, 1]);
    let mut pid = own_pid;
    while protected.insert(pid) {
        let Some(row) = procs.get(&pid) else { break };
        pid = row.ppid;
    }
    protected
}

fn is_shell_or_terminal(comm: &str) -> bool {
    let name = comm
        .rsplit('/')
        .next()
        .unwrap_or(comm)
        .trim_start_matches('-');
    matches!(
        name,
        "zsh"
            | "bash"
            | "sh"
            | "fish"
            | "dash"
            | "tcsh"
            | "ksh"
            | "login"
            | "sshd"
            | "tmux"
            | "screen"
            | "Terminal"
            | "iTerm2"
            | "launchd"
    )
}

fn cwd_outside_project(pid: u32, project_path: Option<&str>, cwds: &HashMap<u32, String>) -> bool {
    match (project_path, cwds.get(&pid)) {
        (Some(project), Some(cwd)) => !Path::new(cwd).starts_with(Path::new(project)),
        _ => false,
    }
}

/// Find the enclosing supervisor without crossing another listener, terminal,
/// repository, or Redline's own ancestry. The displayed lsof comm is never an
/// identity token: Node workers legitimately have a different ps title.
fn stop_root(
    target: u32,
    port: u16,
    procs: &HashMap<u32, ProcRow>,
    listeners: &[RawListener],
    own_pid: u32,
    project_path: Option<&str>,
    cwds: &HashMap<u32, String>,
) -> Result<StopPlan, String> {
    let protected = protected_processes(own_pid, procs);
    if protected.contains(&target)
        || procs
            .get(&target)
            .is_some_and(|p| is_shell_or_terminal(&p.comm))
    {
        return Err("that process can't be stopped from here".into());
    }
    if !procs.contains_key(&target) || !listeners.iter().any(|l| l.pid == target && l.port == port)
    {
        return Err(format!("that server is no longer on :{port}"));
    }
    if cwd_outside_project(target, project_path, cwds) {
        return Err("that server is no longer running in this project".into());
    }
    let mut root = target;
    let mut climbed = HashSet::from([target]);
    for _ in 0..MAX_CLIMB {
        let ancestor = procs[&root].ppid;
        let Some(row) = procs.get(&ancestor) else {
            break;
        };
        if !climbed.insert(ancestor)
            || protected.contains(&ancestor)
            || is_shell_or_terminal(&row.comm)
            || listeners
                .iter()
                .any(|l| l.pid == ancestor && l.port != port && l.port < EPHEMERAL_PORT_FLOOR)
            || cwd_outside_project(ancestor, project_path, cwds)
        {
            break;
        }
        root = ancestor;
    }
    let mut members = HashSet::from([root]);
    loop {
        let next: Vec<u32> = procs
            .iter()
            .filter(|(pid, row)| !members.contains(*pid) && members.contains(&row.ppid))
            .map(|(&pid, _)| pid)
            .collect();
        if next.is_empty() {
            break;
        }
        if next.iter().any(|pid| protected.contains(pid)) {
            return Err("that server's process tree includes Redline".into());
        }
        if members.len() + next.len() > MAX_STOP_PIDS {
            return Err(format!(
                "that server has more than {MAX_STOP_PIDS} processes; stop it from its terminal"
            ));
        }
        members.extend(next);
    }
    let mut pids: Vec<u32> = members.iter().copied().collect();
    pids.sort_unstable();
    let mut collateral_ports: Vec<u16> = listeners
        .iter()
        .filter(|l| members.contains(&l.pid) && l.port != port && l.port < EPHEMERAL_PORT_FLOOR)
        .map(|l| l.port)
        .collect();
    collateral_ports.sort_unstable();
    collateral_ports.dedup();
    Ok(StopPlan {
        root,
        root_label: procs[&root].comm.clone(),
        pids,
        collateral_ports,
    })
}

/// ps start time is captured alongside the process table, then checked again
/// immediately before each signal batch. A reparented child is still the same
/// process; a recycled pid with a new start time must never be signalled.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcIdentity {
    started: String,
    comm: String,
}

fn parse_ps_snapshot(output: &str) -> (HashMap<u32, ProcRow>, HashMap<u32, ProcIdentity>) {
    let mut tree_text = String::new();
    let mut identities = HashMap::new();
    for line in output.lines() {
        let mut rest = line.trim_start();
        let mut fields = Vec::new();
        // pid, ppid, then lstart's weekday/month/day/time/year; comm may
        // contain spaces and slashes, so preserve its entire remainder.
        for _ in 0..7 {
            let Some((field, tail)) = rest.split_once(char::is_whitespace) else {
                break;
            };
            fields.push(field);
            rest = tail.trim_start();
        }
        if fields.len() != 7 || rest.is_empty() {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u32>() else {
            continue;
        };
        if fields[1].parse::<u32>().is_err() {
            continue;
        }
        tree_text.push_str(&format!("{} {} {}\n", fields[0], fields[1], rest));
        identities.insert(
            pid,
            ProcIdentity {
                started: fields[2..].join(" "),
                comm: rest.into(),
            },
        );
    }
    (parse_ps_tree(&tree_text), identities)
}

fn matching_pids(
    pids: &[u32],
    expected: &HashMap<u32, ProcIdentity>,
    current: &HashMap<u32, ProcIdentity>,
) -> Vec<u32> {
    pids.iter()
        .copied()
        .filter(|pid| {
            expected
                .get(pid)
                .is_some_and(|id| current.get(pid) == Some(id))
        })
        .collect()
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
    "/usr",
    "/opt",
    "/Library",
    "/System",
    "/Applications",
    "/private",
    "/bin",
    "/sbin",
    "/var",
    "/nix",
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
    probe.lockfile = [
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "package-lock.json",
    ]
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

/// Short command names (`lsof`'s `c` field) that make a process a plausible
/// dev-server runtime. `node` is deliberately absent from `RUNNERS` — as an
/// argv token it is far too common — but as the process's OWN command it is
/// solid evidence, so it belongs here.
const RUNTIME_COMMS: [&str; 15] = [
    "node", "bun", "deno", "npm", "pnpm", "yarn", "python", "python3", "ruby", "java", "php",
    "dotnet", "cargo", "go", "air",
];

/// Does this process actually claim to be the project's dev server, or does it
/// merely happen to have the repo as its cwd?
///
/// The cwd→project mapping alone is too generous. A live scan proved it: four
/// copies of an unrelated, long-dead binary — started from a terminal inside
/// the repo and reparented to launchd — were each presented as a full
/// "Vite — redline" card, because their cwd was the repo and the repo's
/// `package.json` names Vite. Nothing about those processes said "dev server";
/// only their working directory did.
///
/// So a card now needs one of three affirmative signals:
///   * argv names a runner we recognize (`vite`, `next`, `uvicorn`, …), or
///   * the process's own command is a language runtime or package manager, or
///   * argv[0] resolves inside the project root — which is what keeps a
///     genuinely compiled in-repo server (`target/debug/api`, a Go binary, a
///     repo-built single-file executable) as a real card.
///
/// A relative argv[0] carrying a path separator counts as in-repo: it was
/// resolved against a cwd that this scan already mapped into `root`. A bare
/// name with no separator is a PATH lookup and proves nothing.
pub fn claims_project(comm: &str, args: &str, root: &Path) -> bool {
    if detect_runner(comm, args).is_some() {
        return true;
    }
    let comm_lc = comm.to_ascii_lowercase();
    if RUNTIME_COMMS.contains(&comm_lc.as_str()) {
        return true;
    }
    let Some(argv0) = args.split_whitespace().next() else {
        return false;
    };
    if !argv0.starts_with('/') {
        return argv0.contains('/');
    }
    let argv0 = normalize_path(argv0);
    let root = normalize_path(&root.to_string_lossy());
    argv0 == root || argv0.starts_with(&format!("{root}/"))
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
pub fn derive_run_command(probe: Option<&ProjectProbe>, comm: &str, raw_args: &str) -> String {
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
        .filter(|r| r.port < EPHEMERAL_PORT_FLOOR)
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
pub fn dev_servers_scan(store: tauri::State<'_, SessionStore>) -> Result<DevServerScan, String> {
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
        let ps_out = run_capture("ps", &["-o".into(), "pid=,args=".into(), "-p".into(), list])
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
        let root = cwds
            .get(pid)
            .and_then(|cwd| resolve_project(cwd, &known, home.as_deref(), dir_has_root_marker));
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
        let args = args_by_pid.get(pid).cloned().unwrap_or_default();
        // The repo is this process's cwd — but a neighbor is not a dev server.
        // Same compact row as the no-project branch, and the same point: no
        // probe, no remembered row, no thumbnail work for something that only
        // shares a working directory with the project.
        if !claims_project(comm, &args, &root) {
            if others.len() < MAX_OTHERS {
                others.push(OtherListener {
                    pid: *pid,
                    port,
                    comm: comm.clone(),
                });
            }
            continue;
        }
        let probe = probes
            .entry(root.clone())
            .or_insert_with(|| probe_project(&root));
        let stack = detect_stack(Some(probe), comm, &args);
        let run_command = derive_run_command(Some(probe), comm, &args);
        let project_path = normalize_path(&root.to_string_lossy());
        let project_name = probe.dir_name.clone();
        let url = format!("http://localhost:{port}");

        if port < EPHEMERAL_PORT_FLOOR {
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
        }

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
    let mut recent = partition_recent(rows, &live_keys, &busy_ports, |p| Path::new(p).is_dir());
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

/// The manifest facts needed by the project launch dialog. No script bodies
/// are exposed: a quick pick invokes a script by name through its package manager.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeView {
    pub project_name: String,
    pub stack: String,
    pub run_command: String,
    pub scripts: Vec<String>,
    pub exists: bool,
    pub package_manager: String,
}

#[tauri::command(async)]
pub fn dev_server_probe(project_path: String) -> ProbeView {
    let root = Path::new(&project_path);
    let probe = probe_project(root);
    let mut scripts: Vec<String> = probe.scripts.iter().cloned().collect();
    scripts.sort();
    ProbeView {
        project_name: probe
            .pkg_name
            .clone()
            .or_else(|| probe.cargo_name.clone())
            .unwrap_or_else(|| probe.dir_name.clone()),
        stack: detect_stack(Some(&probe), "", ""),
        run_command: derive_run_command(Some(&probe), "", ""),
        scripts,
        exists: root.is_dir(),
        package_manager: package_manager(probe.lockfile.as_deref()).into(),
    }
}

fn stop_listeners() -> Result<Vec<RawListener>, String> {
    let output = std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        .output()
        .map_err(|e| format!("lsof: {e}"))?;
    // lsof exits 1 when no sockets match. Other failures must not be mistaken
    // for a quiet port and reported as a successful stop.
    if !output.status.success() && !(output.status.code() == Some(1) && output.stderr.is_empty()) {
        return Err(format!(
            "could not inspect listening ports: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(parse_listener_fields(
        &String::from_utf8_lossy(&output.stdout),
        None,
    ))
}

fn process_snapshot() -> Result<(HashMap<u32, ProcRow>, HashMap<u32, ProcIdentity>), String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,lstart=,comm="])
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| format!("ps: {e}"))?;
    if !output.status.success() {
        return Err("could not inspect the process tree".into());
    }
    Ok(parse_ps_snapshot(&String::from_utf8_lossy(&output.stdout)))
}

struct StopSnapshot {
    plan: StopPlan,
    identities: HashMap<u32, ProcIdentity>,
}

fn prepare_stop(pid: u32, port: u16, project_path: Option<&str>) -> Result<StopSnapshot, String> {
    let (procs, identities) = process_snapshot()?;
    if !procs.contains_key(&std::process::id()) {
        return Err("could not inspect Redline’s process ancestry".into());
    }
    let listeners = stop_listeners()?;
    // Only the target and its bounded candidate ancestors need cwd lookups.
    let mut candidates = HashSet::from([pid]);
    let mut cursor = pid;
    for _ in 0..MAX_CLIMB {
        let Some(row) = procs.get(&cursor) else { break };
        if row.ppid <= 1 || !candidates.insert(row.ppid) {
            break;
        }
        cursor = row.ppid;
    }
    let list = candidates
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let cwds = parse_lsof_cwds(&run_capture(
        "lsof",
        &[
            "-a".into(),
            "-p".into(),
            list,
            "-d".into(),
            "cwd".into(),
            "-Fpn".into(),
        ],
    )?);
    let canonical =
        project_path.map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p)));
    let project = canonical
        .as_deref()
        .map(|p| p.to_string_lossy().into_owned());
    let plan = stop_root(
        pid,
        port,
        &procs,
        &listeners,
        std::process::id(),
        project.as_deref(),
        &cwds,
    )?;
    Ok(StopSnapshot { plan, identities })
}

#[tauri::command(async)]
pub fn dev_server_stop_plan(
    pid: u32,
    port: u16,
    project_path: Option<String>,
) -> Result<StopPlan, String> {
    Ok(prepare_stop(pid, port, project_path.as_deref())?.plan)
}

/// Signal only snapshot members whose start identity still matches. Re-check
/// after failures too: a child exiting between ps and kill is successful shutdown.
fn signal_matching(
    signal: &str,
    pids: &[u32],
    identities: &HashMap<u32, ProcIdentity>,
) -> Result<Vec<u32>, String> {
    if pids.is_empty() {
        return Ok(Vec::new());
    }
    let (_, current) = process_snapshot()?;
    let live = matching_pids(pids, identities, &current);
    if live.is_empty() {
        return Ok(live);
    }
    let output = std::process::Command::new("/bin/kill")
        .arg(signal)
        .args(live.iter().map(u32::to_string))
        .output()
        .map_err(|e| format!("kill: {e}"))?;
    if !output.status.success() {
        let (_, after) = process_snapshot()?;
        if !matching_pids(&live, identities, &after).is_empty() {
            return Err(format!(
                "could not stop server: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok(live)
}

fn execute_stop(
    pid: u32,
    port: u16,
    project_path: Option<&str>,
) -> Result<(StopPlan, usize), String> {
    let snapshot = prepare_stop(pid, port, project_path)?;
    // A dry run is advisory only. Check the card's claim again immediately
    // before the first signal, after the slower ancestry/cwd enrichment.
    if !stop_listeners()?
        .iter()
        .any(|l| l.pid == pid && l.port == port)
    {
        return Err(format!("that server is no longer on :{port}"));
    }
    let (_, current) = process_snapshot()?;
    if matching_pids(&snapshot.plan.pids, &snapshot.identities, &current).len()
        != snapshot.plan.pids.len()
    {
        return Err("that server's process tree changed; refresh and try again".into());
    }
    let mut signalled = HashSet::new();
    signalled.extend(signal_matching(
        "-TERM",
        &[snapshot.plan.root],
        &snapshot.identities,
    )?);
    let children: Vec<u32> = snapshot
        .plan
        .pids
        .iter()
        .copied()
        .filter(|p| *p != snapshot.plan.root)
        .collect();
    signalled.extend(signal_matching("-TERM", &children, &snapshot.identities)?);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let (_, current) = process_snapshot()?;
        let remaining = matching_pids(&snapshot.plan.pids, &snapshot.identities, &current);
        let quiet = !stop_listeners()?.iter().any(|l| l.port == port);
        if remaining.is_empty() && quiet {
            break;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    // Also reap a supervisor that released the port but ignored shutdown.
    // Never use kill -0 alone here: those pids may have been recycled in grace.
    signalled.extend(signal_matching(
        "-KILL",
        &snapshot.plan.pids,
        &snapshot.identities,
    )?);
    for _ in 0..4 {
        if !stop_listeners()?.iter().any(|l| l.port == port) {
            return Ok((snapshot.plan, signalled.len()));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(format!(
        "port :{port} is still listening; its server may have restarted"
    ))
}

#[tauri::command(async)]
pub fn dev_server_stop(
    store: tauri::State<'_, SessionStore>,
    pid: u32,
    port: u16,
    project_path: Option<String>,
) -> Result<(), String> {
    let (plan, count) = execute_stop(pid, port, project_path.as_deref())?;
    let detail = format!(
        "root {} ({}), {count} processes signalled, port :{port}",
        plan.root, plan.root_label
    );
    let _ = store.database().append_journal(
        "dev_server_stop",
        Some("servers"),
        Some(&pid.to_string()),
        Some(&detail),
        project_path.as_deref(),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc_tree(rows: &[(u32, u32, &str)]) -> HashMap<u32, ProcRow> {
        rows.iter()
            .map(|&(pid, ppid, comm)| {
                (
                    pid,
                    ProcRow {
                        ppid,
                        comm: comm.into(),
                    },
                )
            })
            .collect()
    }

    fn listener(pid: u32, port: u16) -> RawListener {
        RawListener {
            pid,
            comm: "node".into(),
            port,
        }
    }

    #[test]
    fn stop_accepts_the_lsof_node_vs_ps_next_server_name_mismatch() {
        let tree = proc_tree(&[
            (10, 1, "-zsh"),
            (20, 10, "npm run dev"),
            (21, 20, "next-server (v16.3.4)"),
        ]);
        let plan = stop_root(
            21,
            3103,
            &tree,
            &[listener(21, 3103)],
            99,
            None,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(plan.root, 20);
        assert_eq!(plan.pids, vec![20, 21]);
        assert!(stop_root(
            21,
            3100,
            &tree,
            &[listener(21, 3103)],
            99,
            None,
            &HashMap::new()
        )
        .unwrap_err()
        .contains("no longer on :3100"));
    }

    #[test]
    fn stopping_redlines_vite_never_signals_redline_or_tauri_dev() {
        let tree = proc_tree(&[
            (96031, 1, "tauri dev"),
            (96158, 96031, "npm run dev"),
            (96207, 96158, "node"),
            (96210, 96207, "esbuild"),
            (96246, 96031, "redline"),
        ]);
        let plan = stop_root(
            96207,
            1420,
            &tree,
            &[listener(96207, 1420)],
            96246,
            None,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(plan.root, 96158);
        assert_eq!(plan.pids, vec![96158, 96207, 96210]);
        for target in [96246, 96031, 1] {
            assert!(stop_root(
                target,
                1420,
                &tree,
                &[listener(target, 1420)],
                96246,
                None,
                &HashMap::new()
            )
            .is_err());
        }
    }

    #[test]
    fn another_card_blocks_the_climb_and_parent_stop_reports_collateral() {
        let tree = proc_tree(&[
            (62300, 1, "-zsh"),
            (62343, 62300, "pnpm dev"),
            (62408, 62343, "next-server"),
            (16389, 62408, "npm run dev --port 3103"),
            (16413, 16389, "next dev"),
            (16416, 16413, "next-server"),
        ]);
        let listeners = [
            listener(62408, 3100),
            listener(16416, 3103),
            listener(16413, 52000),
        ];
        let child = stop_root(16416, 3103, &tree, &listeners, 99, None, &HashMap::new()).unwrap();
        assert_eq!(child.root, 16389);
        assert!(child.collateral_ports.is_empty());
        let parent = stop_root(62408, 3100, &tree, &listeners, 99, None, &HashMap::new()).unwrap();
        assert_eq!(parent.root, 62343);
        assert_eq!(parent.collateral_ports, vec![3103]);
        assert_eq!(parent.pids.len(), 5);
    }

    #[test]
    fn stop_respects_login_shell_and_repo_directory_boundaries() {
        let tree = proc_tree(&[(10, 1, "-zsh"), (20, 10, "runner"), (30, 20, "node")]);
        let cwds = HashMap::from([
            (20, "/Users/me/app-sibling".into()),
            (30, "/Users/me/app/packages/web".into()),
        ]);
        assert_eq!(
            stop_root(
                30,
                3000,
                &tree,
                &[listener(30, 3000)],
                99,
                Some("/Users/me/app"),
                &cwds
            )
            .unwrap()
            .root,
            30
        );
        assert_eq!(
            stop_root(30, 3000, &tree, &[listener(30, 3000)], 99, None, &cwds)
                .unwrap()
                .root,
            20
        );
        assert!(stop_root(
            30,
            3000,
            &tree,
            &[listener(30, 3000)],
            99,
            Some("/another"),
            &cwds
        )
        .is_err());
        for shell in [
            "-zsh",
            "/bin/bash",
            "-fish",
            "iTerm2",
            "/Applications/Terminal.app/Contents/MacOS/Terminal",
        ] {
            assert!(is_shell_or_terminal(shell));
        }
    }

    #[test]
    fn stop_walk_has_depth_and_subtree_bounds_and_terminates_on_cycles() {
        let tree: HashMap<u32, ProcRow> = (10..30)
            .map(|pid| {
                (
                    pid,
                    ProcRow {
                        ppid: pid - 1,
                        comm: "node".into(),
                    },
                )
            })
            .collect();
        let plan = stop_root(
            29,
            3000,
            &tree,
            &[listener(29, 3000)],
            99,
            None,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(plan.root, 29 - MAX_CLIMB as u32);
        let cycle = proc_tree(&[(10, 12, "node"), (11, 10, "node"), (12, 11, "node")]);
        let plan = stop_root(
            10,
            3000,
            &cycle,
            &[listener(10, 3000)],
            99,
            None,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(plan.pids, vec![10, 11, 12]);
        let mut wide = proc_tree(&[(10, 1, "node")]);
        for pid in 100..100 + MAX_STOP_PIDS as u32 {
            wide.insert(
                pid,
                ProcRow {
                    ppid: 10,
                    comm: "node".into(),
                },
            );
        }
        assert!(stop_root(
            10,
            3000,
            &wide,
            &[listener(10, 3000)],
            50,
            None,
            &HashMap::new()
        )
        .unwrap_err()
        .contains("more than"));
    }

    #[test]
    fn ps_tree_preserves_spaces_and_slashes_and_rejects_malformed_rows() {
        let tree = parse_ps_tree("  100   10 /Applications/LM Studio.app/Contents/MacOS/LM Studio\n 200 100 next-server (v16.3.4)\n bad 20 node\n 300 bad node\n 400 1\n");
        assert_eq!(tree.len(), 2);
        assert_eq!(
            tree[&100].comm,
            "/Applications/LM Studio.app/Contents/MacOS/LM Studio"
        );
        assert_eq!(tree[&200].ppid, 100);
    }

    #[test]
    fn escalation_excludes_recycled_pids_but_allows_reparented_children() {
        let (_, before) = parse_ps_snapshot("  20 10 Wed Sep 9 10:20:30 2026 next-server (v16.3.4)\n 21 20 Wed Sep 9 10:20:30 2026 node\n");
        let (_, after) = parse_ps_snapshot("  20 1 Wed Sep 9 10:20:30 2026 next-server (v16.3.4)\n 21 1 Wed Sep 9 10:20:31 2026 node\n");
        assert_eq!(matching_pids(&[20, 21, 22], &before, &after), vec![20]);
        assert_eq!(before[&20].comm, "next-server (v16.3.4)");
    }

    #[test]
    fn probe_without_process_argv_uses_lockfile_or_returns_an_editable_blank() {
        let mut probe = ProjectProbe {
            has_package_json: true,
            scripts: HashSet::from(["dev".into()]),
            ..Default::default()
        };
        for (lock, pm) in [
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lockb", "bun"),
            ("package-lock.json", "npm"),
        ] {
            probe.lockfile = Some(lock.into());
            assert_eq!(
                derive_run_command(Some(&probe), "", ""),
                format!("{pm} run dev")
            );
        }
        probe.scripts = HashSet::from(["test".into()]);
        assert_eq!(derive_run_command(Some(&probe), "", ""), "");
    }

    /// These integration fixtures own every process they can stop. No existing
    /// app/server pid or fixed port is ever used. Opt in because they need the
    /// host's python3, ps and lsof and exercise actual TERM/KILL delivery.
    #[test]
    #[ignore = "spawns disposable localhost fixtures; run with --ignored"]
    fn disposable_servers_stop_plain_supervised_and_sigterm_ignoring() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        struct Fixture {
            child: std::process::Child,
            identities: HashMap<u32, ProcIdentity>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let pids: Vec<u32> = self.identities.keys().copied().collect();
                let _ = signal_matching("-KILL", &pids, &self.identities);
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
        for mode in ["plain", "supervised", "ignore"] {
            let source = r#"
import os, signal, socket, subprocess, sys, time
mode = sys.argv[1]
if mode == 'supervised':
    child = subprocess.Popen([sys.executable, '-u', '-c', sys.argv[2], 'plain'])
    def stop(signum, frame):
        child.terminate()
        child.wait()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    while True:
        child.wait()
        child = subprocess.Popen([sys.executable, '-u', '-c', sys.argv[2], 'plain'])
else:
    if mode == 'ignore': signal.signal(signal.SIGTERM, lambda *args: None)
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen()
    print(str(os.getpid()) + ' ' + str(sock.getsockname()[1]), flush=True)
    while True: time.sleep(1)
"#;
            let mut child = Command::new("python3")
                .args(["-u", "-c", source, mode, source])
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let result = std::io::BufReader::new(stdout)
                    .read_line(&mut line)
                    .map(|_| line);
                let _ = sender.send(result);
            });
            let mut fixture = Fixture {
                child,
                identities: HashMap::new(),
            };
            let line = receiver
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
                .unwrap();
            let values: Vec<&str> = line.split_whitespace().collect();
            let pid: u32 = values[0].parse().unwrap();
            let port: u16 = values[1].parse().unwrap();
            let snapshot = prepare_stop(pid, port, None).unwrap();
            fixture.identities = snapshot
                .plan
                .pids
                .iter()
                .map(|pid| (*pid, snapshot.identities[pid].clone()))
                .collect();
            assert_eq!(snapshot.plan.root, fixture.child.id(), "{mode}");
            assert_eq!(
                snapshot.plan.pids.len(),
                if mode == "supervised" { 2 } else { 1 }
            );
            assert!(
                stop_listeners()
                    .unwrap()
                    .iter()
                    .any(|l| l.pid == pid && l.port == port),
                "dry run sent no signal"
            );
            let start = std::time::Instant::now();
            let (plan, count) = execute_stop(pid, port, None).unwrap();
            assert_eq!(plan.root, fixture.child.id());
            assert!(count >= 1);
            if mode == "ignore" {
                assert!(start.elapsed() >= std::time::Duration::from_secs(3));
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
            assert!(
                !stop_listeners().unwrap().iter().any(|l| l.port == port),
                "{mode} respawned"
            );
            fixture.child.wait().unwrap();
        }
    }

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
        assert_eq!(
            args.get(&100).map(String::as_str),
            Some("node /a/b/vite --host")
        );
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
        let got = resolve_project("/Users/me/scratch/thing/src", &known(&[]), HOME, |p| {
            p == Path::new("/Users/me/scratch/thing")
        });
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
            "/Users/me",     // the home dir itself
            "/opt/homebrew", // Homebrew keeps a .git
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
            resolve_project("/Users/me/.vscode/extensions/x", &known(&[]), HOME, |_| {
                true
            }),
            None,
        );
        // Even if the home directory is in the registry (a plan session that
        // launched in $HOME — a real thing that has happened), it must not
        // become every listener's project.
        assert_eq!(
            resolve_project("/Users/me/random/dir", &known(&["/Users/me"]), HOME, |_| {
                false
            }),
            None,
        );
        // But a real repo below home still resolves.
        assert_eq!(
            resolve_project(
                "/Users/me/app/src",
                &known(&["/Users/me/app"]),
                HOME,
                |_| false
            ),
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
        let got = resolve_project("/Users/me/app", &known(&["/Users/me/app/"]), HOME, |_| {
            false
        });
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
            assert_eq!(
                detect_stack(Some(&p), "node", ""),
                format!("{label} — myapp")
            );
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
        assert_eq!(
            detect_runner("node", "node /a/vite-experiments/api.js"),
            None
        );
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
            probe_family(&ProjectProbe {
                has_pyproject: true,
                ..Default::default()
            }),
            Family::Python,
        );
        assert_eq!(
            probe_family(&ProjectProbe {
                has_cargo_toml: true,
                ..Default::default()
            }),
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
            assert_eq!(
                derive_run_command(Some(&p), "node", "node x"),
                format!("{pm} run dev")
            );
        }
    }

    #[test]
    fn run_command_falls_through_start_cargo_manage_then_raw_args() {
        let p = probe_with(&[], &["start"]);
        assert_eq!(
            derive_run_command(Some(&p), "node", "node x"),
            "npm run start"
        );

        let rs = ProjectProbe {
            has_cargo_toml: true,
            ..Default::default()
        };
        assert_eq!(
            derive_run_command(Some(&rs), "node", "target/debug/x"),
            "cargo run"
        );

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

    #[test]
    fn a_neighbor_process_does_not_claim_the_project() {
        let root = Path::new("/Users/me/app");
        // The observed failure: a long-dead standalone binary, living outside
        // the repo, started once from a terminal whose cwd was the repo.
        assert!(!claims_project(
            "legacyapp",
            "/Users/me/.local/bin/legacyapp",
            root
        ));
        // A bare PATH lookup is not evidence either — no separator, no origin.
        assert!(!claims_project("myserver", "myserver --port 9000", root));
        // Nor is an absolute path that merely shares a prefix with the root.
        assert!(!claims_project(
            "appd",
            "/Users/me/app-backup/bin/appd",
            root
        ));
    }

    #[test]
    fn a_real_server_still_claims_the_project() {
        let root = Path::new("/Users/me/app");
        // 1 — argv names a runner.
        assert!(claims_project("sh", "vite --port 5173", root));
        // 2 — the process's own command is a runtime, even with a bare argv.
        assert!(claims_project(
            "node",
            "/opt/homebrew/bin/node server.js",
            root
        ));
        assert!(claims_project("bun", "/usr/local/bin/bun run serve", root));
        // 3 — a compiled binary that lives IN the repo, absolute or relative.
        assert!(claims_project(
            "api",
            "/Users/me/app/target/debug/api",
            root
        ));
        assert!(claims_project(
            "api",
            "./target/debug/api --port 8080",
            root
        ));
        // A trailing slash on the root must not break the prefix test.
        assert!(claims_project(
            "api",
            "/Users/me/app/target/debug/api",
            Path::new("/Users/me/app/")
        ));
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
            row(1, "/a", 5173),    // live right now → not "recent"
            row(2, "/a", 3000),    // same repo, other port → recent
            row(3, "/gone", 8080), // directory no longer exists → dropped
            row(4, "/b", 4000),    // port squatted by a foreign process
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
    fn recent_forgets_os_assigned_ports() {
        // Rows written before the floor existed still sit in the table; the
        // filter is what retires them, without a migration.
        let rows = vec![row(1, "/a", 3000), row(2, "/a", 54441), row(3, "/a", 49152)];
        let got = partition_recent(rows, &HashSet::new(), &HashSet::new(), |_| true);
        assert_eq!(
            got.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![1],
            "only the re-runnable port is worth remembering: {got:?}"
        );
    }

    #[test]
    fn upsert_keeps_first_seen_and_the_thumbnail_across_rescans() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_dev_server(
            "/a",
            "a",
            5173,
            "http://localhost:5173",
            "Vite — a",
            "npm run dev",
            Some(1),
            Some("node x"),
            1_000,
        )
        .unwrap();
        let id = db.list_dev_servers(10).unwrap()[0].id;
        db.set_dev_server_thumb("/a", 5173, "/thumbs/p5173-abc.png")
            .unwrap();
        // A later scan sees the same server with a churned run command.
        db.upsert_dev_server(
            "/a",
            "a",
            5173,
            "http://localhost:5173",
            "Vite — a",
            "pnpm run dev",
            Some(2),
            Some("node y"),
            2_000,
        )
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
    /// never on what happens to be running — and for the "flags stopped
    /// matching" case, plant a listener of our own rather than assume the box
    /// has one (a bare CI runner has none).
    #[test]
    fn a_live_scan_runs_the_real_commands_and_returns_a_coherent_shape() {
        if std::process::Command::new("lsof")
            .arg("-v")
            .output()
            .is_err()
        {
            return; // no lsof on this box — nothing to assert
        }
        let db = Database::open_in_memory().unwrap();
        let scan = scan_with(&db, std::process::id()).expect("a live scan must not error");

        // A wrong lsof flag means empty stdout with a non-zero status, which
        // run_capture still surfaces as Ok("") — an invisibly empty dashboard.
        // Hold a loopback socket and sweep WITHOUT excluding this process: a
        // correct invocation must see at least the listener we planted.
        let planted = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let seeded = scan_with(&Database::open_in_memory().unwrap(), u32::MAX)
            .expect("a live scan must not error");
        assert!(
            !seeded.running.is_empty() || !seeded.others.is_empty(),
            "a planted listener was invisible — the lsof invocation is probably wrong"
        );
        drop(planted);
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
            assert!(
                seen_pids.insert(r.pid),
                "one process must be exactly one card"
            );
            assert!(
                !r.project_path.is_empty(),
                "a running card is project-mapped"
            );
            assert!(!r.project_name.is_empty());
            assert!(!r.stack.is_empty());
            assert_eq!(r.url, format!("http://localhost:{}", r.port));
            assert!(
                r.extra_ports.iter().all(|p| *p > r.port),
                "the primary port is the lowest one the process holds"
            );
            assert!(
                claims_project(&r.comm, &r.args, Path::new(&r.project_path)),
                "a card must be a dev server, not merely a process whose cwd is \
                 the repo: {r:?}"
            );
        }
        // Every running card on a re-runnable port was recorded, and no live
        // server is ever also listed as "recent". Cards on OS-assigned ports
        // are shown but deliberately not remembered.
        let rows = db.list_dev_servers(100).unwrap();
        assert_eq!(
            rows.len(),
            scan.running
                .iter()
                .filter(|r| r.port < EPHEMERAL_PORT_FLOOR)
                .count()
        );
        for r in &scan.running {
            assert!(
                !scan
                    .recent
                    .iter()
                    .any(|x| x.project_path == r.project_path && x.port == r.port),
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

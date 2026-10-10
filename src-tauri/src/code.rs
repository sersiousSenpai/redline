// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Read-only code access for the browser "browse agent": enumerate the user's
//! projects and run a whitelisted set of read-only git commands against them.
//!
//! Reached only through the local daemon's `/v1/code/*` routes over the browse
//! agent's already-authorized `curl` allow — general `Bash(git …)` is auto-denied
//! in headless mode, so this bridge is how the agent inspects branch / diff / log
//! state without fighting the sandbox (the failure mode a real transcript showed:
//! piecing git state together one narrow command at a time).
//!
//! Everything here is read-only and doubly fenced:
//! 1. The op whitelist (`build_git_args`) contains no mutating command and takes
//!    no arbitrary arg passthrough — only fixed templates with sanitized tokens.
//! 2. A `repo` must be one of the user's KNOWN projects (the
//!    `Database::list_project_paths` allowlist), so a malicious page that steers
//!    the headless agent still can't run git at an arbitrary path.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::db::Database;
use crate::worktree;

/// Cap on how many projects we enumerate / `--add-dir`. Keeps the projects map
/// and the spawn arg vector bounded on a machine with a long history.
pub const MAX_PROJECTS: usize = 15;

/// Max bytes of git output returned to the agent (keeps a huge `diff` from
/// blowing up the reply / the daemon response).
const MAX_GIT_OUTPUT: usize = 60_000;

/// One project in the user's de-facto registry, as surfaced to the agent.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub is_git: bool,
    /// Current branch when `is_git`; `None` otherwise.
    pub branch: Option<String>,
    pub summary: Option<String>,
    pub stage: Option<String>,
    pub focus: Option<String>,
    pub summary_source: String,
}

/// The user's known projects, most-recent first, filtered to paths that still
/// exist as directories and capped at `MAX_PROJECTS`, annotated with git status.
/// Backs `GET /v1/code/projects` — the agent's "map of my projects."
pub async fn list_projects(db: &Database) -> Vec<ProjectInfo> {
    let mut out = Vec::new();
    for brief in project_briefs(db) {
        let path = brief.path.clone();
        let p = Path::new(&path);
        let name = brief.name.clone();
        let is_git = is_git_repo(p).await;
        let branch = if is_git {
            worktree::git(p, &["rev-parse", "--abbrev-ref", "HEAD"])
                .await
                .ok()
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        out.push(ProjectInfo { path, name, is_git, branch, summary: brief.summary, stage: brief.stage, focus: brief.focus, summary_source: brief.summary_source });
    }
    out
}

/// Just the existing project directories (capped), for the browse agent's
/// `--add-dir` read boundary. Cheap — no per-repo git probing.
pub fn project_dirs(db: &Database) -> Vec<String> {
    top_level_projects(db.list_project_paths().unwrap_or_default(), std::env::var("HOME").ok().as_deref())
}

async fn is_git_repo(dir: &Path) -> bool {
    worktree::git(dir, &["rev-parse", "--is-inside-work-tree"])
        .await
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// A read-only git request the agent may make (parsed from the route's query).
#[derive(Default)]
pub struct GitRequest<'a> {
    pub repo: &'a str,
    pub op: &'a str,
    pub n: Option<u32>,
    pub git_ref: Option<&'a str>,
    pub base: Option<&'a str>,
    pub file: Option<&'a str>,
    pub stat: bool,
}

/// Run a validated read-only git op in a KNOWN project. Errors (not a known
/// project / not a repo / bad op) are returned as strings for the route to relay.
pub async fn run_git(db: &Database, req: GitRequest<'_>) -> Result<String, String> {
    let repo = req.repo.trim();
    if repo.is_empty() {
        return Err("missing ?repo=".into());
    }
    if !is_known_project(db, repo) {
        return Err(format!(
            "`{repo}` is not one of your known projects — I can only inspect git \
             in projects Redline has seen"
        ));
    }
    let dir = PathBuf::from(repo);
    if !is_git_repo(&dir).await {
        return Err(format!("`{repo}` is not a git repository"));
    }

    let args = build_git_args(&req)?;
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut out = worktree::git(&dir, &argv).await?;
    if out.len() > MAX_GIT_OUTPUT {
        out.truncate(MAX_GIT_OUTPUT);
        out.push_str("\n… (truncated)");
    }
    Ok(out)
}

/// Map a read-only op + its sanitized params to a fixed git arg vector. Pure —
/// this is the security-critical whitelist, unit-tested in isolation. Any op not
/// listed (including every mutating command) is rejected.
fn build_git_args(req: &GitRequest<'_>) -> Result<Vec<String>, String> {
    let s = |v: &str| v.to_string();
    let args = match req.op.trim() {
        "status" => vec![s("status"), s("--short"), s("--branch")],
        "branch" => vec![s("branch"), s("-vv")],
        "log" => {
            let n = req.n.unwrap_or(20).clamp(1, 200).to_string();
            let mut a = vec![s("log"), s("--oneline"), s("-n"), n];
            if let Some(r) = req.git_ref {
                a.push(safe_token(r)?.to_string());
            }
            a
        }
        "diff" => {
            let mut a = vec![s("diff")];
            if req.stat {
                a.push(s("--stat"));
            }
            if let Some(b) = req.base {
                a.push(safe_token(b)?.to_string());
            }
            a
        }
        "show" => {
            let r = req.git_ref.map(safe_token).transpose()?.unwrap_or("HEAD");
            let mut a = vec![s("show")];
            if req.stat {
                a.push(s("--stat"));
            }
            a.push(r.to_string());
            if let Some(f) = req.file {
                a.push(s("--"));
                a.push(safe_token(f)?.to_string());
            }
            a
        }
        other => {
            return Err(format!(
                "`{other}` is not a supported read-only git op \
                 (use status / branch / log / diff / show)"
            ))
        }
    };
    Ok(args)
}

/// Validate a caller-supplied ref / path token before it enters the git arg
/// vector: no leading `-` (blocks flag injection like `--upload-pack=…`), bounded
/// length, no control chars. Returns the trimmed token when acceptable.
/// `pub(crate)`: the code-review resolver (`review.rs`) guards its refs with
/// the same rule.
pub(crate) fn safe_token(v: &str) -> Result<&str, String> {
    let t = v.trim();
    if t.is_empty() {
        return Err("empty value".into());
    }
    if t.len() > 200 {
        return Err("value too long".into());
    }
    if t.starts_with('-') {
        return Err(format!("`{t}` looks like a flag — not allowed"));
    }
    if t.chars().any(|c| c.is_control()) {
        return Err("value has control characters".into());
    }
    Ok(t)
}

/// True when `repo` matches one of the user's known project paths — by exact
/// string or by canonicalized path (collapsing symlinks / trailing slashes so
/// the agent can pass the path however it saw it).
/// `pub(crate)`: the code-review resolver (`review.rs`) reuses this allowlist.
pub(crate) fn is_known_project(db: &Database, repo: &str) -> bool {
    let target = std::fs::canonicalize(repo).ok();
    db.list_project_paths()
        .unwrap_or_default()
        .into_iter()
        .any(|p| {
            p == repo
                || match (std::fs::canonicalize(&p).ok(), &target) {
                    (Some(a), Some(b)) => &a == b,
                    _ => false,
                }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AttachState, ReviewSession, SessionStatus};

    fn req(op: &str) -> GitRequest<'static> {
        GitRequest {
            repo: "/x",
            op: Box::leak(op.to_string().into_boxed_str()),
            ..Default::default()
        }
    }

    #[test]
    fn whitelisted_ops_build_fixed_arg_vectors() {
        assert_eq!(
            build_git_args(&req("status")).unwrap(),
            vec!["status", "--short", "--branch"]
        );
        assert_eq!(build_git_args(&req("branch")).unwrap(), vec!["branch", "-vv"]);
        // log defaults to -n 20.
        assert_eq!(
            build_git_args(&req("log")).unwrap(),
            vec!["log", "--oneline", "-n", "20"]
        );
    }

    #[test]
    fn mutating_and_unknown_ops_are_rejected() {
        for bad in ["commit", "push", "reset", "checkout", "rm", "", "log; rm -rf"] {
            assert!(
                build_git_args(&req(bad)).is_err(),
                "op `{bad}` must be rejected"
            );
        }
    }

    #[test]
    fn log_ref_with_leading_dash_is_rejected() {
        let mut r = req("log");
        r.git_ref = Some("--output=/etc/passwd");
        assert!(build_git_args(&r).is_err());
    }

    #[test]
    fn log_n_is_clamped() {
        let mut r = req("log");
        r.n = Some(99999);
        let args = build_git_args(&r).unwrap();
        assert_eq!(args[3], "200"); // clamped to the ceiling
    }

    #[test]
    fn show_defaults_to_head_and_accepts_a_file() {
        let mut r = req("show");
        r.file = Some("src/main.rs");
        assert_eq!(
            build_git_args(&r).unwrap(),
            vec!["show", "HEAD", "--", "src/main.rs"]
        );
    }

    #[test]
    fn safe_token_rejects_flags_control_and_overlong() {
        assert!(safe_token("-rf").is_err());
        assert!(safe_token("").is_err());
        assert!(safe_token("a\nb").is_err());
        assert!(safe_token(&"x".repeat(500)).is_err());
        assert_eq!(safe_token(" main ").unwrap(), "main");
    }

    #[test]
    fn list_project_paths_dedupes_and_orders_by_recency() {
        let db = Database::open_in_memory().unwrap();
        let mk = |id: &str, path: &str, at: i64| ReviewSession {
            session_id: id.to_string(),
            project_path: path.to_string(),
            project_name: "p".to_string(),
            created_at: at,
            revisions: Vec::new(),
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: at,
            run_state: None,
            backend: None,
            model: None,
            effort: None,
        };
        db.upsert_session(&mk("s1", "/a", 100)).unwrap();
        db.upsert_session(&mk("s2", "/b", 300)).unwrap();
        db.upsert_session(&mk("s3", "/a", 200)).unwrap(); // same path, newer
        let paths = db.list_project_paths().unwrap();
        // /a appears once, and its newest timestamp (200) sorts it below /b (300).
        assert_eq!(paths, vec!["/b".to_string(), "/a".to_string()]);
    }

    #[test]
    fn unknown_repo_is_not_a_known_project() {
        let db = Database::open_in_memory().unwrap();
        assert!(!is_known_project(&db, "/definitely/not/a/project"));
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectBrief {
    pub name: String, pub path: String, pub aliases: Vec<String>, pub summary: Option<String>,
    pub stage: Option<String>, pub focus: Option<String>, pub summary_source: String,
}
#[derive(Default, Debug)]
struct ProjectCard { name: Option<String>, aliases: Vec<String>, one_liner: Option<String>, stage: Option<String>, focus: Option<String>, stack: Option<String>, adjacent: Vec<String> }
fn compact(value: &str, max: usize) -> String { value.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect() }
fn scalar(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') { if let Ok(s) = serde_json::from_str::<String>(value) { return s; } }
    value.trim_matches('\'').trim_matches('"').to_owned()
}
fn list(value: &str) -> Vec<String> {
    value.trim().trim_start_matches('[').trim_end_matches(']').split(',').map(scalar).filter(|v| !v.is_empty()).take(16).collect()
}
/// Bounded YAML front matter. Only the owned scalar/list vocabulary is read;
/// tags, anchors and arbitrary body content cannot become prompt instructions.
fn parse_project_card(raw: &str) -> ProjectCard {
    let mut card = ProjectCard::default(); let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") { return card; }
    let mut section = String::new();
    for line in lines {
        if line.trim() == "---" { break; }
        let trimmed = line.trim(); if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        if trimmed.starts_with("- ") {
            let item = compact(&scalar(trimmed.trim_start_matches("- ")), 80);
            if section == "aliases" && card.aliases.len() < 16 { card.aliases.push(item); }
            else if section == "adjacent" && card.adjacent.len() < 16 { card.adjacent.push(item); }
            continue;
        }
        if line.starts_with(char::is_whitespace) && section == "one_liner" {
            card.one_liner = Some(compact(&format!("{} {}", card.one_liner.as_deref().unwrap_or(""), trimmed), 220)); continue;
        }
        let Some((key, raw)) = trimmed.split_once(':') else { continue };
        section = key.trim().to_owned(); let value = compact(&scalar(raw), 220);
        let nonempty = (!value.is_empty()).then_some(value.clone());
        match section.as_str() {
            "name" => card.name = nonempty.map(|name| compact(&name,80)),
            "aliases" => card.aliases = list(raw), "one_liner" => card.one_liner = if ["|", ">", "|-", ">-"].contains(&value.as_str()) { Some(String::new()) } else { nonempty },
            "stage" => card.stage = nonempty, "focus" => card.focus = nonempty, "stack" => card.stack = nonempty,
            "adjacent" => card.adjacent = list(raw), _ => {},
        }
    }
    card
}
fn read_project_text(repo: &Path, name: &str) -> Option<String> {
    use std::io::Read;
    let path = repo.join(name).canonicalize().ok()?;
    if !path.starts_with(repo.canonicalize().ok()?) { return None; }
    let mut bytes = Vec::new(); std::fs::File::open(path).ok()?.take(8192).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}
fn plain_paragraph(raw: &str) -> Option<String> {
    let mut paragraph = Vec::new(); let mut fenced = false; let mut frontmatter = raw.starts_with("---\n");
    for (index, line) in raw.lines().chain(std::iter::once("")).enumerate() {
        let text = line.trim();
        if frontmatter { if index > 0 && text == "---" { frontmatter = false; } continue; }
        if text.starts_with("```") || text.starts_with("~~~") { fenced = !fenced; paragraph.clear(); continue; }
        if fenced { continue; }
        if text.is_empty() {
            let joined = paragraph.join(" "); paragraph.clear();
            if joined.split_whitespace().count() >= 8 && !(joined.starts_with("**") && joined.ends_with("**") || joined.starts_with('_') && joined.ends_with('_') || joined.starts_with('*') && joined.ends_with('*')) { return Some(compact(&joined,220)); }
        } else if text.starts_with(['#','<','!','|','>']) || text.starts_with("[![") || text.starts_with("- ") || text.starts_with("* ") { paragraph.clear(); }
        else { paragraph.push(text); }
    }
    None
}
fn top_level_projects(paths: Vec<String>, home: Option<&str>) -> Vec<String> {
    let home = home.and_then(|path| std::fs::canonicalize(path).ok());
    let mut seen = std::collections::HashSet::new();
    let paths: Vec<_> = paths.into_iter().filter_map(|path| {
        let canonical = std::fs::canonicalize(&path).ok()?;
        (canonical.is_dir() && Some(&canonical) != home.as_ref() && seen.insert(canonical.clone())).then_some((path,canonical))
    }).collect();
    paths.iter().filter(|(_,path)| !paths.iter().any(|(_,parent)| path != parent && path.starts_with(parent))).take(MAX_PROJECTS).map(|(path,_)| path.clone()).collect()
}
fn brief_for_path(db: &Database, path: String) -> ProjectBrief {
    let repo = Path::new(&path);
    let card = read_project_text(repo,".redline/project.md").map(|text| parse_project_card(&text)).unwrap_or_default();
    let mut summary = card.one_liner.filter(|s| !s.trim().is_empty()); let mut source = if summary.is_some() { "project_card" } else { "none" };
    for (file, kind) in [("README.md","readme"),("CLAUDE.md","claude")] { if summary.is_none() { summary = read_project_text(repo,file).and_then(|text| plain_paragraph(&text)); if summary.is_some() { source = kind; } } }
    if summary.is_none() { summary = read_project_text(repo,"package.json").and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok()).and_then(|value| value["description"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_owned)); if summary.is_some() { source = "package"; } }
    if summary.is_none() { summary = read_project_text(repo,"Cargo.toml").and_then(|text| text.parse::<toml::Value>().ok()).and_then(|value| value.get("package")?.get("description")?.as_str().filter(|s| !s.trim().is_empty()).map(str::to_owned)); if summary.is_some() { source = "cargo"; } }
    if summary.is_none() { summary = db.read_conn().query_row("SELECT title FROM class_nodes WHERE parent_id IS NULL AND project_path=?1 AND retired_by_run IS NULL ORDER BY updated_at DESC LIMIT 1", [&path], |row| row.get::<_,String>(0)).ok(); if summary.is_some() { source = "classmemory"; } }
    ProjectBrief { name: card.name.unwrap_or_else(|| repo.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())), path, aliases: card.aliases, summary: summary.map(|text| compact(&text,220)), stage: card.stage, focus: card.focus, summary_source: source.into() }
}
pub fn project_briefs(db: &Database) -> Vec<ProjectBrief> { project_dirs(db).into_iter().map(|path| brief_for_path(db,path)).collect() }
fn mention_key(value: &str) -> String { value.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect() }
/// Only callers' user text/mission goals enter this matcher, never page snapshots.
pub fn resolve_project_mentions<'a>(text: &str, briefs: &'a [ProjectBrief]) -> Vec<&'a ProjectBrief> {
    let words: Vec<_> = text.split_whitespace().map(mention_key).collect();
    let phrases: std::collections::HashSet<String> = (1..=3).flat_map(|size| words.windows(size).map(|words| words.concat())).filter(|key| key.chars().count() >= 4).collect();
    briefs.iter().filter(|brief| std::iter::once(&brief.name).chain(brief.aliases.iter()).map(|name| mention_key(name)).any(|key| key.chars().count() >= 4 && phrases.contains(&key))).collect()
}
pub fn project_map(path: &str) -> String {
    let repo = Path::new(path); let mut out = format!("Project feature map: {path}\n");
    if let Some(readme) = read_project_text(repo,"README.md") {
        let mut section = None;
        for line in readme.lines() { let depth = line.chars().take_while(|c| *c == '#').count(); let lower = line.to_lowercase();
            if depth > 0 { if ["layout","architecture","structure"].iter().any(|key| lower.contains(key)) { section = Some(depth); } else if section.is_some_and(|level| depth <= level) { section = None; } }
            if section.is_some() { out.push_str(line); out.push('\n'); }
        }
    }
    if let Some(guide) = read_project_text(repo,"CLAUDE.md") { out.push_str("\nCLAUDE.md headings:\n"); for line in guide.lines().filter(|line| line.starts_with('#')) { out.push_str(line); out.push('\n'); } }
    out.push_str("\nSource tree (two levels):\n");
    fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut String) {
        if depth == 0 || out.len() >= MAX_GIT_OUTPUT { return; }
        let Ok(entries) = std::fs::read_dir(dir) else { return }; let mut entries: Vec<_> = entries.filter_map(Result::ok).collect(); entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if out.len() >= MAX_GIT_OUTPUT { break; }
            let name = entry.file_name().to_string_lossy().into_owned();
            if ["build","target","node_modules",".git","dist"].contains(&name.as_str()) || name.ends_with(".xcassets") { continue; }
            let Ok(kind) = entry.file_type() else { continue }; if kind.is_symlink() { continue; }
            out.push_str(&format!("{prefix}{name}{}\n", if kind.is_dir() { "/" } else { "" }));
            if kind.is_dir() { walk(&entry.path(), &format!("{prefix}  "), depth-1, out); }
        }
    }
    walk(repo,"",2,&mut out);
    if out.len() > MAX_GIT_OUTPUT { let mut end = MAX_GIT_OUTPUT; while !out.is_char_boundary(end) { end-=1; } out.truncate(end); }
    out
}
pub fn known_project_map(db: &Database, path: &str) -> Result<String,String> {
    if !is_known_project(db,path) { return Err("Feature maps are only available for known projects".into()); }
    Ok(project_map(path))
}

#[cfg(test)] mod project_context_tests {
    use super::*;
    use crate::state::{AttachState, ReviewSession, SessionStatus};
    struct Repo(PathBuf);
    impl Repo { fn new() -> Self { let path = std::env::temp_dir().join(format!("redline-project-context-{}",uuid::Uuid::new_v4())); std::fs::create_dir_all(&path).unwrap(); Self(path) } fn write(&self,name:&str,text:&str) { let path=self.0.join(name); std::fs::create_dir_all(path.parent().unwrap()).unwrap(); std::fs::write(path,text).unwrap(); } }
    impl Drop for Repo { fn drop(&mut self) { let _=std::fs::remove_dir_all(&self.0); } }
    fn register(db:&Database,path:&Path) { db.upsert_session(&ReviewSession { session_id:uuid::Uuid::new_v4().to_string(),project_path:path.display().to_string(),project_name:"MachineOS".into(),created_at:1,updated_at:1,revisions:vec![],status:SessionStatus::InReview,attach_state:AttachState::Idle,run_state:None,backend:None,model:None,effort:None }).unwrap(); }
    #[test] fn frontmatter_reads_owned_fields_and_both_alias_forms() {
        let card=parse_project_card("---\nname: MachineOS\naliases: ['machine OS', vehicle-twin]\none_liner: >\n  An iPhone digital twin of your vehicle\n  with a mechanic assistant.\nstage: beta\nfocus: LiDAR\nstack: Swift\nadjacent:\n  - CarSignal\n---\nIgnored body");
        assert_eq!(card.name.as_deref(),Some("MachineOS")); assert_eq!(card.aliases,vec!["machine OS","vehicle-twin"]); assert!(card.one_liner.unwrap().contains("mechanic assistant")); assert_eq!(card.adjacent,vec!["CarSignal"]);
        assert_eq!(parse_project_card("---\naliases:\n  - \"Machine OS\"\n---").aliases,vec!["Machine OS"]);
    }
    #[test] fn excludes_home_nested_paths_and_duplicate_canonical_paths() {
        let home=Repo::new(); home.write("machineos/MachineOS/source.swift",""); home.write("redline/src/a.ts","");
        let parent=home.0.join("machineos"); let other=home.0.join("redline");
        assert_eq!(top_level_projects(vec![home.0.display().to_string(),parent.join("MachineOS").display().to_string(),parent.display().to_string(),other.display().to_string(),parent.display().to_string()],Some(home.0.to_str().unwrap())),vec![parent.display().to_string(),other.display().to_string()]);
    }
    #[test] fn summary_fallbacks_skip_badges_taglines_and_headings() {
        let repo=Repo::new(); let db=Database::open_in_memory().unwrap(); let path=repo.0.display().to_string();
        assert_eq!(brief_for_path(&db,path.clone()).summary,None);
        repo.write("README.md","# Product\n\n[![badge](x)](y)\n\n**Your agent workspace**\n\n<details>ignore</details>\n\nA desktop workspace where developers review plans and build applications together.\n");
        assert_eq!(brief_for_path(&db,path.clone()).summary_source,"readme");
        repo.write(".redline/project.md","---\nname: MachineOS\none_liner: Vehicle twin\nstage: prototype\nfocus: LiDAR\n---");
        assert_eq!(brief_for_path(&db,path.clone()).summary.as_deref(),Some("Vehicle twin"));
        std::fs::remove_file(repo.0.join(".redline/project.md")).unwrap(); repo.write("README.md","# Empty\n\nShort tagline\n");
        repo.write("CLAUDE.md","# Guide\n\nThis is a useful detailed guide to the phone vehicle application.\n"); assert_eq!(brief_for_path(&db,path.clone()).summary_source,"claude");
        repo.write("CLAUDE.md",""); repo.write("package.json",r#"{"description":"Package description"}"#); assert_eq!(brief_for_path(&db,path.clone()).summary_source,"package");
        repo.write("package.json","{}"); repo.write("Cargo.toml","[package]\ndescription='Cargo description'\n"); assert_eq!(brief_for_path(&db,path.clone()).summary_source,"cargo");
        repo.write("Cargo.toml",""); db.lock_conn().execute("INSERT INTO class_nodes(id,title,project_path,created_at,updated_at) VALUES('root','Vehicle twin app',?1,0,0)",[&path]).unwrap(); assert_eq!(brief_for_path(&db,path).summary_source,"classmemory");
    }
    #[test] fn resolves_only_complete_normalized_name_windows_and_aliases() {
        let brief=|name:&str,aliases:Vec<String>| ProjectBrief { name:name.into(),path:format!("/{name}"),aliases,summary:None,stage:None,focus:None,summary_source:"none".into() };
        let briefs=vec![brief("machineos",vec!["vehicle twin".into()]),brief("redline",vec![]),brief("hb",vec![])];
        assert_eq!(resolve_project_mentions("Does machine OS complement Redline?",&briefs).iter().map(|p|p.name.as_str()).collect::<Vec<_>>(),vec!["machineos","redline"]);
        assert_eq!(resolve_project_mentions("vehicle twin and machine-os",&briefs).len(),1);
        assert!(resolve_project_mentions("redlines and hb on the machine",&briefs).is_empty());
    }
    #[test] fn map_is_bounded_skips_generated_assets_and_rejects_unknown_projects() {
        let repo=Repo::new(); let db=Database::open_in_memory().unwrap(); repo.write("README.md","# App\n## Architecture\nSpatial tracks your car.\n## Install\nDo not include this.\n"); repo.write("CLAUDE.md","# App\n## AI mechanic\n"); repo.write("Spatial/Tracking.swift",""); repo.write("AI/Mechanic/Repair.swift",""); for name in ["build","target","node_modules",".git","dist","Car.xcassets"] { repo.write(&format!("{name}/secret"),""); }
        let path=repo.0.to_str().unwrap(); assert!(known_project_map(&db,path).is_err()); register(&db,&repo.0); let map=known_project_map(&db,path).unwrap(); assert!(map.contains("Spatial/")); assert!(map.contains("Mechanic/")); assert!(!map.contains("Repair.swift")); assert!(!map.contains("secret")); assert!(!map.contains("Do not include"));
        for i in 0..1500 { repo.write(&format!("module-{i:04}-{}", "x".repeat(80)),""); } assert!(project_map(path).len()<=MAX_GIT_OUTPUT);
    }
    #[test] fn index_budget_for_fifteen_projects_and_host_facts() {
        let briefs=(0..15).map(|i|ProjectBrief{name:format!("project-{i}"),path:format!("/repo-{i}"),aliases:vec![],summary:None,stage:None,focus:None,summary_source:"none".into()}).collect::<Vec<_>>();
        let block=crate::claude_proc::project_index_block(&briefs); assert!(block.len()<1400); assert!(!block.contains("/repo-")); assert!(block.contains("8–10")); let host=crate::claude_proc::host_context_block(); assert!(host.contains("today is")); assert!(host.contains("home"));
    }
}

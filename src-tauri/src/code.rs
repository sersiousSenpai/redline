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
}

/// The user's known projects, most-recent first, filtered to paths that still
/// exist as directories and capped at `MAX_PROJECTS`, annotated with git status.
/// Backs `GET /v1/code/projects` — the agent's "map of my projects."
pub async fn list_projects(db: &Database) -> Vec<ProjectInfo> {
    let mut out = Vec::new();
    for path in db.list_project_paths().unwrap_or_default() {
        if out.len() >= MAX_PROJECTS {
            break;
        }
        let p = Path::new(&path);
        if !p.is_dir() {
            continue;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let is_git = is_git_repo(p).await;
        let branch = if is_git {
            worktree::git(p, &["rev-parse", "--abbrev-ref", "HEAD"])
                .await
                .ok()
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        out.push(ProjectInfo { path, name, is_git, branch });
    }
    out
}

/// Just the existing project directories (capped), for the browse agent's
/// `--add-dir` read boundary. Cheap — no per-repo git probing.
pub fn project_dirs(db: &Database) -> Vec<String> {
    db.list_project_paths()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .take(MAX_PROJECTS)
        .collect()
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

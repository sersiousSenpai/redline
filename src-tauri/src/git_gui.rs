// SPDX-License-Identifier: Apache-2.0
//! Repository view: a full git client for one known project, in git's own
//! words. Every command validates `repo` against the known-project
//! allowlist, every write holds the per-repo lock and announces itself with
//! `git-gui-changed`, and errors carry git's own trimmed stderr.
//!
//! Trust boundary: these are `#[tauri::command]`s only; no bridge route
//! reaches this module. Argv is built here from validated parts, refs pass
//! `safe_token` (and `check-ref-format` where a name is created), paths go
//! after `--` as `:(literal)` pathspecs, and no shell is involved.
use crate::{
    code::safe_token,
    guided,
    push::{self, GitRun},
    review::{self, DiffFile, ReviewState},
};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Emitter;

/// Reads and plain local writes.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Writes that run user hooks (commit, merge, rebase) may legitimately be slow.
const HOOK_TIMEOUT: Duration = Duration::from_secs(300);
/// Fetch, pull and push talk to a remote.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);
/// The well-known empty tree: a root commit's diff base.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_LOG: u32 = 500;
/// Pin diff output to what `parse_unified_diff` and `git apply` expect,
/// whatever the user's diff config says (prefixes, external tools, color).
const DIFF_FLAGS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-U3",
];
/// Record separator first so a commit is one `\x1e` chunk; fields are NUL
/// separated and the free-text subject is last.
const LOG_FORMAT: &str = "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s";
const DETAIL_FORMAT: &str =
    "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%cn%x00%ct%x00%s%x00%b";
pub(crate) const CHANGED_EVENT: &str = "git-gui-changed";

// --- wire shapes ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// One of `M A D R C T ? U`.
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkingStatus {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub in_progress: Option<String>,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub conflicted: Vec<GitFileEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefDecoration {
    pub name: String,
    /// `head` | `local` | `remote` | `tag`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub date: i64,
    pub refs: Vec<GitRefDecoration>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    #[serde(flatten)]
    pub commit: GitCommit,
    pub body: String,
    pub committer_name: String,
    pub committer_date: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLocalBranch {
    pub name: String,
    pub sha: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub current: bool,
    pub gone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteBranch {
    pub remote: String,
    pub name: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub index: u32,
    pub message: String,
    pub sha: String,
    pub date: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefs {
    pub current: Option<String>,
    pub local: Vec<GitLocalBranch>,
    pub remote: Vec<GitRemoteBranch>,
    pub tags: Vec<GitTag>,
    pub stashes: Vec<GitStash>,
    pub remotes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    /// stdout then stderr, raw.
    pub output: String,
    pub conflicts: Vec<String>,
}

// --- runner ----------------------------------------------------------------------

/// Every invocation: unquoted UTF-8 paths, no color, and an editor that
/// accepts the default message so `--continue` never waits on a tty.
async fn git(
    dir: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<GitRun, String> {
    let mut argv = vec!["-c", "core.quotePath=false", "-c", "color.ui=false"];
    argv.extend_from_slice(args);
    push::git_write_env(
        dir,
        &argv,
        stdin,
        timeout,
        &[("GIT_EDITOR", "true"), ("GIT_MERGE_AUTOEDIT", "no")],
    )
    .await
}

/// git's own words for a failure: stderr, else stdout ("nothing to commit"
/// is printed to stdout), else the exit code.
fn failure(run: &GitRun, args: &[&str]) -> String {
    let err = run.stderr.trim();
    if !err.is_empty() {
        return err.into();
    }
    let out = run.stdout.trim();
    if !out.is_empty() {
        return out.into();
    }
    format!(
        "git {} exited with code {}",
        args.first().unwrap_or(&""),
        run.code
    )
}

fn combined(run: &GitRun) -> String {
    let mut out = run.stdout.clone();
    if !run.stderr.is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&run.stderr);
    }
    out
}

/// A read: no optional locks, so the 4 s status poll never takes the index
/// lock out from under an agent mid-edit. Raw stdout on exit 0.
async fn read(dir: &Path, args: &[&str]) -> Result<String, String> {
    read_ok(dir, args, &[]).await
}

async fn read_ok(dir: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String, String> {
    let mut argv = vec!["--no-optional-locks"];
    argv.extend_from_slice(args);
    let run = git(dir, &argv, None, LOCAL_TIMEOUT).await?;
    if run.code == 0 || ok_codes.contains(&run.code) {
        Ok(run.stdout)
    } else {
        Err(failure(&run, args))
    }
}

/// True when the probe exits 0; for `--verify --quiet` style questions.
async fn succeeds(dir: &Path, args: &[&str]) -> bool {
    let mut argv = vec!["--no-optional-locks"];
    argv.extend_from_slice(args);
    git(dir, &argv, None, LOCAL_TIMEOUT)
        .await
        .is_ok_and(|r| r.code == 0)
}

async fn write(
    dir: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<GitOpResult, String> {
    let run = git(dir, args, stdin, timeout).await?;
    if run.code == 0 {
        Ok(GitOpResult {
            output: combined(&run),
            conflicts: Vec::new(),
        })
    } else {
        Err(failure(&run, args))
    }
}

/// A write that may stop on conflicts (merge, rebase, pull, cherry-pick,
/// revert, stash apply). Stopping with unmerged paths is a result the UI
/// resolves, not an error; any other failure is.
async fn write_or_conflict(
    dir: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<GitOpResult, String> {
    let run = git(dir, args, None, timeout).await?;
    if run.code == 0 {
        return Ok(GitOpResult {
            output: combined(&run),
            conflicts: Vec::new(),
        });
    }
    let conflicts = unmerged(dir).await?;
    if conflicts.is_empty() {
        return Err(failure(&run, args));
    }
    Ok(GitOpResult {
        output: combined(&run),
        conflicts,
    })
}

fn nul_list(text: &str) -> Vec<String> {
    text.split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

async fn unmerged(dir: &Path) -> Result<Vec<String>, String> {
    Ok(nul_list(
        &read(dir, &["diff", "--name-only", "--diff-filter=U", "-z"]).await?,
    ))
}

async fn has_head(dir: &Path) -> bool {
    succeeds(dir, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).await
}

async fn current_branch(dir: &Path) -> Option<String> {
    read(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// --- validation ----------------------------------------------------------------------

/// Any user-supplied revision: no flag shape, and it must name a commit.
async fn commit_sha(dir: &Path, value: &str) -> Result<String, String> {
    let value = safe_token(value)?;
    let spec = format!("{value}^{{commit}}");
    read(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &spec,
        ],
    )
    .await
    .map(|s| s.trim().to_string())
    .ok()
    .filter(|s| !s.is_empty())
    .ok_or_else(|| format!("`{value}` is not a commit"))
}

/// A branch name exactly as git would store it. `--branch` alone expands
/// `@{-1}`, so the echo must match and the strict `refs/heads/` form must pass.
async fn branch_name(dir: &Path, name: &str) -> Result<String, String> {
    let name = safe_token(name)?;
    let loose = git(
        dir,
        &["check-ref-format", "--branch", name],
        None,
        LOCAL_TIMEOUT,
    )
    .await?;
    let full = format!("refs/heads/{name}");
    let strict = git(dir, &["check-ref-format", &full], None, LOCAL_TIMEOUT).await?;
    if loose.code != 0 || loose.stdout.trim() != name || strict.code != 0 {
        return Err(format!("`{name}` is not a valid branch name"));
    }
    Ok(name.to_string())
}

async fn tag_name(dir: &Path, name: &str) -> Result<String, String> {
    let name = safe_token(name)?;
    let full = format!("refs/tags/{name}");
    if !succeeds(dir, &["check-ref-format", &full]).await {
        return Err(format!("`{name}` is not a valid tag name"));
    }
    Ok(name.to_string())
}

async fn remotes(dir: &Path) -> Result<Vec<String>, String> {
    Ok(read(dir, &["remote"])
        .await?
        .lines()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .collect())
}

/// Exact membership in `git remote`, never a URL or a flag.
async fn remote_name(dir: &Path, remote: &str) -> Result<String, String> {
    let remote = safe_token(remote)?;
    if !remotes(dir).await?.iter().any(|r| r == remote) {
        return Err(format!("`{remote}` is not a configured remote"));
    }
    Ok(remote.to_string())
}

async fn stash_ref(dir: &Path, index: u32) -> Result<String, String> {
    let spec = format!("stash@{{{index}}}");
    if !succeeds(dir, &["rev-parse", "--verify", "--quiet", &spec]).await {
        return Err(format!("{spec} does not exist"));
    }
    Ok(spec)
}

fn literal(path: &str) -> String {
    format!(":(literal){path}")
}

/// Repo-relative paths as literal pathspecs (glob characters are file names).
fn pathspecs(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    paths
        .iter()
        .map(|p| review::safe_rel_path(p).map(literal))
        .collect()
}

// --- status ------------------------------------------------------------------------------

fn file_code(c: char) -> String {
    match c {
        'M' | 'A' | 'D' | 'R' | 'C' | 'T' => c.to_string(),
        _ => "M".into(),
    }
}

/// `status --porcelain=v2 -z --branch`. A rename record (`2`) carries its
/// source path in the next NUL field, attached to whichever side renamed.
pub(crate) fn parse_status(out: &str) -> GitWorkingStatus {
    let mut status = GitWorkingStatus::default();
    let mut fields = out.split('\0');
    while let Some(rec) = fields.next() {
        if let Some(header) = rec.strip_prefix("# ") {
            if let Some(v) = header.strip_prefix("branch.oid ") {
                status.head = (v != "(initial)").then(|| v.to_string());
            } else if let Some(v) = header.strip_prefix("branch.head ") {
                status.branch = (v != "(detached)").then(|| v.to_string());
            } else if let Some(v) = header.strip_prefix("branch.upstream ") {
                status.upstream = Some(v.to_string());
            } else if let Some(v) = header.strip_prefix("branch.ab ") {
                for part in v.split_whitespace() {
                    if let Some(n) = part.strip_prefix('+') {
                        status.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        status.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let (kind, parts) = match rec.chars().next() {
            Some('1') => ('1', rec.splitn(9, ' ').collect::<Vec<_>>()),
            Some('2') => ('2', rec.splitn(10, ' ').collect()),
            Some('u') => ('u', rec.splitn(11, ' ').collect()),
            Some('?') => {
                if let Some(path) = rec.strip_prefix("? ") {
                    status.unstaged.push(GitFileEntry {
                        path: path.into(),
                        old_path: None,
                        status: "?".into(),
                    });
                }
                continue;
            }
            _ => continue,
        };
        let orig = if kind == '2' { fields.next() } else { None };
        let (Some(xy), Some(path)) = (parts.get(1), parts.last()) else {
            continue;
        };
        if parts.len() < 9 {
            continue;
        }
        if kind == 'u' {
            status.conflicted.push(GitFileEntry {
                path: (*path).into(),
                old_path: None,
                status: "U".into(),
            });
            continue;
        }
        let mut codes = xy.chars();
        let (x, y) = (codes.next().unwrap_or('.'), codes.next().unwrap_or('.'));
        let entry = |c: char| GitFileEntry {
            path: (*path).into(),
            old_path: orig.filter(|_| matches!(c, 'R' | 'C')).map(str::to_string),
            status: file_code(c),
        };
        if x != '.' {
            status.staged.push(entry(x));
        }
        if y != '.' {
            status.unstaged.push(entry(y));
        }
    }
    status
}

pub(crate) async fn status(dir: &Path) -> Result<GitWorkingStatus, String> {
    let out = read(
        dir,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )
    .await?;
    let mut status = parse_status(&out);
    // The contract's vocabulary has no bisect; that is not a stopped write.
    status.in_progress = push::in_progress_op(dir).await.filter(|op| op != "bisect");
    Ok(status)
}

// --- diffs ----------------------------------------------------------------------------------

/// `new path -> old path` for renames/copies staged in the index, so a
/// rename's two halves travel together through diff and unstage.
async fn staged_renames(dir: &Path) -> Result<HashMap<String, String>, String> {
    let out = read(dir, &["diff", "--cached", "-M", "--name-status", "-z"]).await?;
    let mut map = HashMap::new();
    let mut fields = out.split('\0').filter(|s| !s.is_empty());
    while let Some(code) = fields.next() {
        if code.starts_with('R') || code.starts_with('C') {
            if let (Some(old), Some(new)) = (fields.next(), fields.next()) {
                map.insert(new.to_string(), old.to_string());
            }
        } else {
            fields.next();
        }
    }
    Ok(map)
}

async fn diff_text(dir: &Path, lead: &[&str], tail: &[&str]) -> Result<String, String> {
    let mut args: Vec<&str> = lead.to_vec();
    args.extend_from_slice(DIFF_FLAGS);
    args.extend_from_slice(tail);
    read(dir, &args).await
}

pub(crate) async fn file_diff(
    dir: &Path,
    path: &str,
    area: &str,
) -> Result<Option<DiffFile>, String> {
    let path = review::safe_rel_path(path)?;
    let spec = literal(path);
    let text = match area {
        "staged" => {
            let old = staged_renames(dir).await?.remove(path).map(|p| literal(&p));
            let mut tail = vec!["--", spec.as_str()];
            if let Some(old) = &old {
                tail.push(old);
            }
            diff_text(dir, &["diff", "--cached", "-M"], &tail).await?
        }
        "unstaged" => {
            let untracked = read(
                dir,
                &[
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    &spec,
                ],
            )
            .await?;
            if nul_list(&untracked).iter().any(|p| p == path) {
                // `git diff` never shows untracked files; `--no-index`
                // exits 1 when the sides differ, which is the normal case.
                let mut args = vec!["diff", "--no-index"];
                args.extend_from_slice(DIFF_FLAGS);
                args.extend_from_slice(&["--", "/dev/null", path]);
                read_ok(dir, &args, &[1]).await?
            } else if !read(dir, &["ls-files", "-u", "-z", "--", &spec])
                .await?
                .is_empty()
            {
                // An unmerged path's worktree diff is a combined diff the
                // parser does not read; against HEAD it shows the markers.
                diff_text(dir, &["diff", "-M", "HEAD"], &["--", &spec]).await?
            } else {
                diff_text(dir, &["diff", "-M"], &["--", &spec]).await?
            }
        }
        other => return Err(format!("unknown diff area `{other}`")),
    };
    Ok(review::parse_unified_diff(&text).into_iter().next())
}

async fn parents_of(dir: &Path, sha: &str) -> Result<Vec<String>, String> {
    let line = read(dir, &["rev-list", "--parents", "-n", "1", sha, "--"]).await?;
    Ok(line
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect())
}

pub(crate) async fn commit_files(dir: &Path, sha: &str) -> Result<Vec<DiffFile>, String> {
    let sha = commit_sha(dir, sha).await?;
    let parents = parents_of(dir, &sha).await?;
    let base = parents.first().map_or(EMPTY_TREE, String::as_str);
    let text = diff_text(dir, &["diff", "-M"], &[base, &sha, "--"]).await?;
    Ok(review::parse_unified_diff(&text))
}

pub(crate) async fn stash_files(dir: &Path, index: u32) -> Result<Vec<DiffFile>, String> {
    let stash = stash_ref(dir, index).await?;
    let base = format!("{stash}^1");
    let mut text = diff_text(dir, &["diff", "-M"], &[&base, &stash, "--"]).await?;
    // `stash -u` keeps untracked files in a parentless third commit.
    let untracked = format!("{stash}^3");
    if succeeds(dir, &["rev-parse", "--verify", "--quiet", &untracked]).await {
        text.push_str(&diff_text(dir, &["diff"], &[EMPTY_TREE, &untracked, "--"]).await?);
    }
    Ok(review::parse_unified_diff(&text))
}

// --- history ---------------------------------------------------------------------------------

/// `%D` under `--decorate=full`, so a local branch named `origin/x` can't be
/// mistaken for a remote one. Remote `HEAD` symrefs and other namespaces
/// (stash, notes) are not shown.
pub(crate) fn parse_decorations(text: &str) -> Vec<GitRefDecoration> {
    let deco = |name: &str, kind: &str| GitRefDecoration {
        name: name.into(),
        kind: kind.into(),
    };
    text.split(", ")
        .filter_map(|item| {
            let item = item.trim();
            if let Some(branch) = item.strip_prefix("HEAD -> ") {
                Some(deco(
                    branch.strip_prefix("refs/heads/").unwrap_or(branch),
                    "head",
                ))
            } else if item == "HEAD" {
                Some(deco("HEAD", "head"))
            } else if let Some(tag) = item.strip_prefix("tag: ") {
                Some(deco(tag.strip_prefix("refs/tags/").unwrap_or(tag), "tag"))
            } else if let Some(local) = item.strip_prefix("refs/heads/") {
                Some(deco(local, "local"))
            } else if let Some(remote) = item.strip_prefix("refs/remotes/") {
                (!remote.ends_with("/HEAD")).then(|| deco(remote, "remote"))
            } else {
                None
            }
        })
        .collect()
}

fn commit_from(fields: &[&str]) -> GitCommit {
    GitCommit {
        sha: fields[0].into(),
        parents: fields[1].split_whitespace().map(str::to_string).collect(),
        author_name: fields[2].into(),
        author_email: fields[3].into(),
        date: fields[4].trim().parse().unwrap_or(0),
        refs: parse_decorations(fields[5]),
        subject: String::new(),
    }
}

pub(crate) fn parse_log(out: &str) -> Vec<GitCommit> {
    out.split('\u{1e}')
        .filter_map(|rec| {
            let fields: Vec<&str> = rec.splitn(7, '\0').collect();
            if fields.len() != 7 {
                return None;
            }
            let mut commit = commit_from(&fields);
            commit.subject = fields[6].trim_end_matches('\n').into();
            Some(commit)
        })
        .collect()
}

pub(crate) async fn log(
    dir: &Path,
    skip: u32,
    limit: u32,
    all: bool,
) -> Result<Vec<GitCommit>, String> {
    if !all && !has_head(dir).await {
        return Ok(Vec::new());
    }
    let n = format!("--max-count={}", limit.clamp(1, MAX_LOG));
    let skip = format!("--skip={skip}");
    let mut args = vec![
        "log",
        "--date-order",
        "--no-show-signature",
        "--decorate=full",
        "--decorate-refs-exclude=refs/stash",
        LOG_FORMAT,
        &n,
        &skip,
    ];
    if all {
        // `--exclude` only applies to the `--all` that follows it.
        args.extend_from_slice(&["--exclude=refs/stash", "--all"]);
    } else {
        args.push("HEAD");
    }
    args.push("--");
    Ok(parse_log(&read(dir, &args).await?))
}

pub(crate) async fn commit_detail(dir: &Path, sha: &str) -> Result<GitCommitDetail, String> {
    let sha = commit_sha(dir, sha).await?;
    let out = read(
        dir,
        &[
            "show",
            "-s",
            "--no-show-signature",
            "--decorate=full",
            "--decorate-refs-exclude=refs/stash",
            DETAIL_FORMAT,
            &sha,
            "--",
        ],
    )
    .await?;
    let fields: Vec<&str> = out.splitn(10, '\0').collect();
    if fields.len() != 10 {
        return Err(format!("could not read commit {sha}"));
    }
    let mut commit = commit_from(&fields);
    commit.subject = fields[8].into();
    Ok(GitCommitDetail {
        commit,
        body: fields[9].trim_end().into(),
        committer_name: fields[6].into(),
        committer_date: fields[7].trim().parse().unwrap_or(0),
    })
}

pub(crate) async fn last_message(dir: &Path) -> Result<String, String> {
    if !has_head(dir).await {
        return Ok(String::new());
    }
    Ok(read(dir, &["log", "-1", "--format=%B", "HEAD", "--"])
        .await?
        .trim_end()
        .to_string())
}

// --- refs ----------------------------------------------------------------------------------------

/// `%(upstream:track,nobracket)`: "ahead 1, behind 2" | "gone" | "".
fn parse_track(track: &str) -> (u32, u32, bool) {
    let (mut ahead, mut behind) = (0, 0);
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, track.trim() == "gone")
}

pub(crate) async fn refs(dir: &Path) -> Result<GitRefs, String> {
    let remotes = remotes(dir).await?;
    let local_out = read(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)",
            "refs/heads",
        ],
    )
    .await?;
    let local = local_out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() != 5 {
                return None;
            }
            let (ahead, behind, gone) = parse_track(f[3]);
            Some(GitLocalBranch {
                name: f[0].strip_prefix("refs/heads/").unwrap_or(f[0]).into(),
                sha: f[1].into(),
                upstream: (!f[2].is_empty()).then(|| f[2].to_string()),
                ahead,
                behind,
                current: f[4] == "*",
                gone,
            })
        })
        .collect();
    let remote_out = read(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/remotes",
        ],
    )
    .await?;
    let remote = remote_out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() != 3 || !f[2].is_empty() {
                return None;
            }
            let name = f[0].strip_prefix("refs/remotes/")?;
            Some(GitRemoteBranch {
                remote: remote_of(&remotes, name)?.into(),
                name: name.into(),
                sha: f[1].into(),
            })
        })
        .collect();
    let tag_out = read(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(*objectname)",
            "refs/tags",
        ],
    )
    .await?;
    let tags = tag_out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() != 3 {
                return None;
            }
            Some(GitTag {
                name: f[0].strip_prefix("refs/tags/").unwrap_or(f[0]).into(),
                // An annotated tag points at a tag object; show its commit.
                sha: if f[2].is_empty() { f[1] } else { f[2] }.into(),
            })
        })
        .collect();
    let stash_out = read(dir, &["stash", "list", "--format=%gd%x00%H%x00%ct%x00%gs"]).await?;
    let stashes = stash_out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(4, '\0').collect();
            if f.len() != 4 {
                return None;
            }
            let index = f[0]
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(GitStash {
                index,
                message: f[3].into(),
                sha: f[1].into(),
                date: f[2].trim().parse().unwrap_or(0),
            })
        })
        .collect();
    Ok(GitRefs {
        current: current_branch(dir).await,
        local,
        remote,
        tags,
        stashes,
        remotes,
    })
}

/// Remote names may contain `/`; the longest configured prefix wins.
fn remote_of<'a>(remotes: &'a [String], name: &str) -> Option<&'a str> {
    remotes
        .iter()
        .filter(|r| name.starts_with(&format!("{r}/")))
        .max_by_key(|r| r.len())
        .map(String::as_str)
}

// --- recovery copies -----------------------------------------------------------------------------

/// The canonical path of a repo-relative file, refusing anything whose
/// parent resolves outside the project (a symlinked directory).
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let full = root.join(review::safe_rel_path(rel)?);
    let parent = full.parent().ok_or("invalid file path")?;
    let mut ancestor = parent;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("invalid file path")?;
    }
    let resolved = std::fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err(format!("`{rel}` points outside the project"));
    }
    Ok(full)
}

/// Copy a file or directory tree; a symlink is kept as a `.symlink` note
/// holding its target so the copy never follows it out of the project.
fn copy_entry(src: &Path, dest: &Path) -> Result<(), String> {
    let Ok(meta) = src.symlink_metadata() else {
        return Ok(());
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src).map_err(|e| e.to_string())?;
        let mut note = dest.as_os_str().to_owned();
        note.push(".symlink");
        std::fs::write(note, target.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    } else if meta.is_dir() {
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == ".git" {
                continue;
            }
            copy_entry(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(src, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Before a write that destroys worktree content, copy the affected paths
/// to `.git/redline-undo/<id>/files/` with a `meta.json` (the same folder
/// `review_revert` keeps its recovery copies in). Returns the folder.
async fn save_recovery(dir: &Path, op: &str, paths: &BTreeSet<String>) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let folder = push::undo_folder(dir, &id).await?;
    let files = folder.join("files");
    std::fs::create_dir_all(&files).map_err(|e| e.to_string())?;
    for rel in paths {
        copy_entry(&inside(&root, rel)?, &files.join(rel))?;
    }
    let head = read(dir, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string());
    let meta = serde_json::json!({
        "repo": root,
        "op": op,
        "head": head,
        "paths": paths,
        "createdAt": crate::state::now_millis(),
    });
    std::fs::write(folder.join("meta.json"), meta.to_string()).map_err(|e| e.to_string())?;
    Ok(folder)
}

fn recovery_note(folder: &Path) -> String {
    format!("Recovery copy saved to {}\n", folder.display())
}

// --- working tree writes -------------------------------------------------------------------------

pub(crate) async fn stage(dir: &Path, paths: &[String]) -> Result<GitOpResult, String> {
    let specs = pathspecs(paths)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(specs.iter().map(String::as_str));
    write(dir, &args, None, LOCAL_TIMEOUT).await
}

pub(crate) async fn unstage(dir: &Path, paths: &[String]) -> Result<GitOpResult, String> {
    let mut specs = pathspecs(paths)?;
    if !has_head(dir).await {
        // Nothing to restore from on an unborn branch: drop the entries.
        let mut args = vec!["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"];
        args.extend(specs.iter().map(String::as_str));
        return write(dir, &args, None, LOCAL_TIMEOUT).await;
    }
    let renames = staged_renames(dir).await?;
    for path in paths {
        if let Some(old) = renames.get(path) {
            specs.push(literal(old));
        }
    }
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(specs.iter().map(String::as_str));
    write(dir, &args, None, LOCAL_TIMEOUT).await
}

pub(crate) async fn discard(dir: &Path, paths: &[String]) -> Result<GitOpResult, String> {
    let specs = pathspecs(paths)?;
    let root = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    let mut ls = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
    ls.extend(specs.iter().map(String::as_str));
    let untracked: HashSet<String> = nul_list(&read(dir, &ls).await?).into_iter().collect();
    let (gone, kept): (Vec<&String>, Vec<&String>) =
        paths.iter().partition(|p| untracked.contains(p.as_str()));
    let targets: Vec<PathBuf> = gone
        .iter()
        .map(|p| inside(&root, p))
        .collect::<Result<_, _>>()?;
    for (path, rel) in targets.iter().zip(&gone) {
        if path.symlink_metadata().is_ok_and(|m| m.is_dir()) {
            return Err(format!("`{rel}` is a directory"));
        }
    }
    let all: BTreeSet<String> = paths.iter().cloned().collect();
    let folder = save_recovery(dir, "discard", &all).await?;
    let mut result = GitOpResult {
        output: recovery_note(&folder),
        conflicts: Vec::new(),
    };
    if !kept.is_empty() {
        let mut args = vec!["restore", "--worktree", "--"];
        let specs: Vec<String> = kept.iter().map(|p| literal(p)).collect();
        args.extend(specs.iter().map(String::as_str));
        result
            .output
            .push_str(&write(dir, &args, None, LOCAL_TIMEOUT).await?.output);
    }
    for (path, rel) in targets.iter().zip(&gone) {
        // `remove_file` on a symlink removes the link, never its target.
        std::fs::remove_file(path).map_err(|e| format!("{rel}: {e}"))?;
        result
            .output
            .push_str(&format!("Removed untracked {rel}\n"));
    }
    Ok(result)
}

/// Paths a patch touches, for the recovery copy of a worktree apply.
fn patch_paths(patch: &str) -> BTreeSet<String> {
    review::parse_unified_diff(patch)
        .iter()
        .flat_map(|f| [f.old_path.clone(), f.new_path.clone()])
        .filter(|p| p != "/dev/null" && review::safe_rel_path(p).is_ok())
        .collect()
}

pub(crate) async fn apply_patch(
    dir: &Path,
    patch: &str,
    target: &str,
    reverse: bool,
) -> Result<GitOpResult, String> {
    if patch.trim().is_empty() {
        return Err("the patch is empty".into());
    }
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    match target {
        "index" => args.push("--cached"),
        "worktree" => {}
        other => return Err(format!("unknown apply target `{other}`")),
    }
    if reverse {
        args.push("-R");
    }
    // `git apply` rejects a patch whose last line is unterminated.
    let mut patch = patch.to_string();
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    let note = if target == "worktree" {
        recovery_note(&save_recovery(dir, "apply", &patch_paths(&patch)).await?)
    } else {
        String::new()
    };
    let mut result = write(dir, &args, Some(patch.as_bytes()), LOCAL_TIMEOUT).await?;
    result.output.insert_str(0, &note);
    Ok(result)
}

pub(crate) async fn commit(dir: &Path, message: &str, amend: bool) -> Result<GitOpResult, String> {
    if message.trim().is_empty() {
        return Err("the commit message is empty".into());
    }
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    write(dir, &args, Some(message.as_bytes()), HOOK_TIMEOUT).await
}

// --- remotes -------------------------------------------------------------------------------------

pub(crate) async fn fetch(dir: &Path) -> Result<GitOpResult, String> {
    write(dir, &["fetch", "--all", "--prune"], None, NETWORK_TIMEOUT).await
}

pub(crate) async fn pull(dir: &Path, rebase: bool) -> Result<GitOpResult, String> {
    // Explicit either way, so an unset `pull.rebase` never refuses to pick.
    let mode = if rebase { "--rebase" } else { "--no-rebase" };
    write_or_conflict(dir, &["pull", "--no-edit", mode], NETWORK_TIMEOUT).await
}

pub(crate) async fn push_branch(
    dir: &Path,
    remote: &str,
    branch: &str,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<GitOpResult, String> {
    let remote = remote_name(dir, remote).await?;
    let branch = branch_name(dir, branch).await?;
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let mut args = vec!["push"];
    if set_upstream {
        args.push("--set-upstream");
    }
    if force_with_lease {
        args.push("--force-with-lease");
    }
    args.extend_from_slice(&["--", &remote, &refspec]);
    write(dir, &args, None, NETWORK_TIMEOUT).await
}

// --- branches and history writes -----------------------------------------------------------------

pub(crate) async fn checkout(dir: &Path, target: &str, kind: &str) -> Result<GitOpResult, String> {
    match kind {
        "branch" => {
            let name = branch_name(dir, target).await?;
            let full = format!("refs/heads/{name}");
            if !succeeds(dir, &["show-ref", "--verify", "--quiet", &full]).await {
                return Err(format!("no local branch named `{name}`"));
            }
            write(dir, &["switch", "--no-guess", &name], None, LOCAL_TIMEOUT).await
        }
        "remote" => {
            let target = safe_token(target)?;
            let full = format!("refs/remotes/{target}");
            if !succeeds(dir, &["show-ref", "--verify", "--quiet", &full]).await {
                return Err(format!("no remote branch named `{target}`"));
            }
            let remotes = remotes(dir).await?;
            let local = remote_of(&remotes, target)
                .and_then(|r| target.strip_prefix(&format!("{r}/")))
                .ok_or_else(|| format!("`{target}` is not under a configured remote"))?;
            // Already tracked locally: switch to that branch instead of
            // failing on "a branch named ... already exists".
            let local_ref = format!("refs/heads/{local}");
            let tracking = read(
                dir,
                &["for-each-ref", "--format=%(upstream:short)", &local_ref],
            )
            .await
            .unwrap_or_default();
            if tracking.trim() == target {
                return write(dir, &["switch", "--no-guess", local], None, LOCAL_TIMEOUT).await;
            }
            write(dir, &["switch", "--track", target], None, LOCAL_TIMEOUT).await
        }
        "commit" => {
            let sha = commit_sha(dir, target).await?;
            write(dir, &["switch", "--detach", &sha], None, LOCAL_TIMEOUT).await
        }
        other => Err(format!("unknown checkout kind `{other}`")),
    }
}

pub(crate) async fn branch_create(
    dir: &Path,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> Result<GitOpResult, String> {
    let name = branch_name(dir, name).await?;
    // The token itself (not its sha) so a remote start point sets up tracking.
    let start = match start_point.map(str::trim).filter(|s| !s.is_empty()) {
        Some(start) => {
            commit_sha(dir, start).await?;
            start.to_string()
        }
        None => "HEAD".into(),
    };
    if checkout {
        write(dir, &["switch", "-c", &name, &start], None, LOCAL_TIMEOUT).await
    } else {
        write(dir, &["branch", "--", &name, &start], None, LOCAL_TIMEOUT).await
    }
}

pub(crate) async fn branch_delete(
    dir: &Path,
    name: &str,
    force: bool,
) -> Result<GitOpResult, String> {
    let name = branch_name(dir, name).await?;
    if current_branch(dir).await.as_deref() == Some(name.as_str()) {
        return Err(format!(
            "`{name}` is checked out; switch to another branch first"
        ));
    }
    let flag = if force { "-D" } else { "-d" };
    write(dir, &["branch", flag, "--", &name], None, LOCAL_TIMEOUT).await
}

pub(crate) async fn merge(dir: &Path, target: &str, no_ff: bool) -> Result<GitOpResult, String> {
    let target = safe_token(target)?;
    commit_sha(dir, target).await?;
    let mut args = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    args.extend_from_slice(&["--", target]);
    write_or_conflict(dir, &args, HOOK_TIMEOUT).await
}

pub(crate) async fn rebase(dir: &Path, onto: &str) -> Result<GitOpResult, String> {
    let onto = safe_token(onto)?;
    commit_sha(dir, onto).await?;
    write_or_conflict(dir, &["rebase", "--", onto], HOOK_TIMEOUT).await
}

async fn stopped_op(dir: &Path) -> Result<&'static str, String> {
    match push::in_progress_op(dir).await.as_deref() {
        Some("merge") => Ok("merge"),
        Some("rebase") => Ok("rebase"),
        Some("cherry-pick") => Ok("cherry-pick"),
        Some("revert") => Ok("revert"),
        _ => Err("no merge, rebase, cherry-pick or revert is in progress".into()),
    }
}

pub(crate) async fn continue_op(dir: &Path) -> Result<GitOpResult, String> {
    let op = stopped_op(dir).await?;
    write_or_conflict(dir, &[op, "--continue"], HOOK_TIMEOUT).await
}

pub(crate) async fn abort_op(dir: &Path) -> Result<GitOpResult, String> {
    let op = stopped_op(dir).await?;
    write(dir, &[op, "--abort"], None, LOCAL_TIMEOUT).await
}

/// Cherry-pick and revert of a merge commit are taken relative to its first
/// parent (`-m 1`), the mainline the history view draws.
async fn mainline_args(dir: &Path, sha: &str) -> Result<Vec<&'static str>, String> {
    Ok(if parents_of(dir, sha).await?.len() > 1 {
        vec!["-m", "1"]
    } else {
        Vec::new()
    })
}

pub(crate) async fn cherry_pick(dir: &Path, sha: &str) -> Result<GitOpResult, String> {
    let sha = commit_sha(dir, sha).await?;
    let mut args = vec!["cherry-pick"];
    args.extend(mainline_args(dir, &sha).await?);
    args.push(&sha);
    write_or_conflict(dir, &args, HOOK_TIMEOUT).await
}

pub(crate) async fn revert_commit(dir: &Path, sha: &str) -> Result<GitOpResult, String> {
    let sha = commit_sha(dir, sha).await?;
    let mut args = vec!["revert", "--no-edit"];
    args.extend(mainline_args(dir, &sha).await?);
    args.push(&sha);
    write_or_conflict(dir, &args, HOOK_TIMEOUT).await
}

pub(crate) async fn reset(dir: &Path, sha: &str, mode: &str) -> Result<GitOpResult, String> {
    let sha = commit_sha(dir, sha).await?;
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(format!("unknown reset mode `{other}`")),
    };
    let mut note = String::new();
    if mode == "hard" {
        // Everything a hard reset overwrites: worktree and index changes,
        // plus untracked files the target commit would clobber.
        let mut paths: BTreeSet<String> =
            nul_list(&read(dir, &["diff", "--name-only", "--no-renames", "-z"]).await?)
                .into_iter()
                .collect();
        paths.extend(nul_list(
            &read(
                dir,
                &["diff", "--cached", "--name-only", "--no-renames", "-z"],
            )
            .await?,
        ));
        let untracked: HashSet<String> =
            nul_list(&read(dir, &["ls-files", "--others", "--exclude-standard", "-z"]).await?)
                .into_iter()
                .collect();
        if !untracked.is_empty() {
            let target_files = read(dir, &["ls-tree", "-r", "--name-only", "-z", &sha]).await?;
            paths.extend(
                nul_list(&target_files)
                    .into_iter()
                    .filter(|p| untracked.contains(p)),
            );
        }
        note = recovery_note(&save_recovery(dir, "reset --hard", &paths).await?);
    }
    let mut result = write(dir, &["reset", flag, &sha, "--"], None, LOCAL_TIMEOUT).await?;
    result.output.insert_str(0, &note);
    Ok(result)
}

pub(crate) async fn tag_create(
    dir: &Path,
    name: &str,
    sha: &str,
    message: Option<&str>,
) -> Result<GitOpResult, String> {
    let name = tag_name(dir, name).await?;
    let sha = commit_sha(dir, sha).await?;
    match message.filter(|m| !m.trim().is_empty()) {
        Some(message) => {
            write(
                dir,
                &["tag", "-a", "-F", "-", "--", &name, &sha],
                Some(message.as_bytes()),
                LOCAL_TIMEOUT,
            )
            .await
        }
        None => write(dir, &["tag", "--", &name, &sha], None, LOCAL_TIMEOUT).await,
    }
}

pub(crate) async fn tag_delete(dir: &Path, name: &str) -> Result<GitOpResult, String> {
    let name = tag_name(dir, name).await?;
    write(dir, &["tag", "-d", "--", &name], None, LOCAL_TIMEOUT).await
}

pub(crate) async fn stash_save(
    dir: &Path,
    message: &str,
    include_untracked: bool,
) -> Result<GitOpResult, String> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    let message = message.trim();
    if !message.is_empty() {
        args.extend_from_slice(&["-m", message]);
    }
    write(dir, &args, None, LOCAL_TIMEOUT).await
}

pub(crate) async fn stash_apply(dir: &Path, index: u32, pop: bool) -> Result<GitOpResult, String> {
    let stash = stash_ref(dir, index).await?;
    let verb = if pop { "pop" } else { "apply" };
    write_or_conflict(dir, &["stash", verb, &stash], LOCAL_TIMEOUT).await
}

pub(crate) async fn stash_drop(dir: &Path, index: u32) -> Result<GitOpResult, String> {
    let stash = stash_ref(dir, index).await?;
    write(dir, &["stash", "drop", &stash], None, LOCAL_TIMEOUT).await
}

// --- commands --------------------------------------------------------------------------------------

type Locked = (PathBuf, tokio::sync::OwnedMutexGuard<()>);

async fn locked(state: &ReviewState, repo: &str) -> Result<Locked, String> {
    let dir = review::checked_repo_dir(&state.db, repo).await?;
    let lock = guided::repo_lock(&dir).await;
    Ok((dir, lock))
}

/// Announce every finished write, failed ones included: a failed pull or a
/// conflicted merge can still have moved refs or the index.
fn announced<T>(
    app: &tauri::AppHandle,
    repo: &str,
    result: Result<T, String>,
) -> Result<T, String> {
    let _ = app.emit(CHANGED_EVENT, serde_json::json!({ "repo": repo }));
    result
}

#[tauri::command]
pub async fn git_gui_status(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<GitWorkingStatus, String> {
    status(&review::checked_repo_dir(&state.db, &repo).await?).await
}

#[tauri::command]
pub async fn git_gui_file_diff(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    path: String,
    area: String,
) -> Result<Option<DiffFile>, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    file_diff(&dir, &path, &area).await
}

#[tauri::command]
pub async fn git_gui_log(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    skip: u32,
    limit: u32,
    all: bool,
) -> Result<Vec<GitCommit>, String> {
    log(
        &review::checked_repo_dir(&state.db, &repo).await?,
        skip,
        limit,
        all,
    )
    .await
}

#[tauri::command]
pub async fn git_gui_commit_detail(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    sha: String,
) -> Result<GitCommitDetail, String> {
    commit_detail(&review::checked_repo_dir(&state.db, &repo).await?, &sha).await
}

#[tauri::command]
pub async fn git_gui_commit_files(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    sha: String,
) -> Result<Vec<DiffFile>, String> {
    commit_files(&review::checked_repo_dir(&state.db, &repo).await?, &sha).await
}

#[tauri::command]
pub async fn git_gui_refs(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<GitRefs, String> {
    refs(&review::checked_repo_dir(&state.db, &repo).await?).await
}

#[tauri::command]
pub async fn git_gui_last_message(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<String, String> {
    last_message(&review::checked_repo_dir(&state.db, &repo).await?).await
}

#[tauri::command]
pub async fn git_gui_stash_files(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    index: u32,
) -> Result<Vec<DiffFile>, String> {
    stash_files(&review::checked_repo_dir(&state.db, &repo).await?, index).await
}

#[tauri::command]
pub async fn git_gui_stage(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    paths: Vec<String>,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, stage(&dir, &paths).await)
}

#[tauri::command]
pub async fn git_gui_unstage(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    paths: Vec<String>,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, unstage(&dir, &paths).await)
}

#[tauri::command]
pub async fn git_gui_discard(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    paths: Vec<String>,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, discard(&dir, &paths).await)
}

#[tauri::command]
pub async fn git_gui_apply_patch(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    patch: String,
    target: String,
    reverse: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(
        &app,
        &repo,
        apply_patch(&dir, &patch, &target, reverse).await,
    )
}

#[tauri::command]
pub async fn git_gui_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    message: String,
    amend: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, commit(&dir, &message, amend).await)
}

#[tauri::command]
pub async fn git_gui_fetch(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, fetch(&dir).await)
}

#[tauri::command]
pub async fn git_gui_pull(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    rebase: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, pull(&dir, rebase).await)
}

#[tauri::command]
pub async fn git_gui_push(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    remote: String,
    branch: String,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    let result = push_branch(&dir, &remote, &branch, set_upstream, force_with_lease).await;
    announced(&app, &repo, result)
}

#[tauri::command]
pub async fn git_gui_checkout(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    target: String,
    kind: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, checkout(&dir, &target, &kind).await)
}

#[tauri::command]
pub async fn git_gui_branch_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    let result = branch_create(&dir, &name, start_point.as_deref(), checkout).await;
    announced(&app, &repo, result)
}

#[tauri::command]
pub async fn git_gui_branch_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    name: String,
    force: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, branch_delete(&dir, &name, force).await)
}

#[tauri::command]
pub async fn git_gui_merge(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    target: String,
    no_ff: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, merge(&dir, &target, no_ff).await)
}

#[tauri::command]
pub async fn git_gui_rebase(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    onto: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, rebase(&dir, &onto).await)
}

#[tauri::command]
pub async fn git_gui_continue(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, continue_op(&dir).await)
}

#[tauri::command]
pub async fn git_gui_abort(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, abort_op(&dir).await)
}

#[tauri::command]
pub async fn git_gui_cherry_pick(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    sha: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, cherry_pick(&dir, &sha).await)
}

#[tauri::command]
pub async fn git_gui_revert_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    sha: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, revert_commit(&dir, &sha).await)
}

#[tauri::command]
pub async fn git_gui_reset(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    sha: String,
    mode: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, reset(&dir, &sha, &mode).await)
}

#[tauri::command]
pub async fn git_gui_tag_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    name: String,
    sha: String,
    message: Option<String>,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    let result = tag_create(&dir, &name, &sha, message.as_deref()).await;
    announced(&app, &repo, result)
}

#[tauri::command]
pub async fn git_gui_tag_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    name: String,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, tag_delete(&dir, &name).await)
}

#[tauri::command]
pub async fn git_gui_stash_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    message: String,
    include_untracked: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(
        &app,
        &repo,
        stash_save(&dir, &message, include_untracked).await,
    )
}

#[tauri::command]
pub async fn git_gui_stash_apply(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    index: u32,
    pop: bool,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, stash_apply(&dir, index, pop).await)
}

#[tauri::command]
pub async fn git_gui_stash_drop(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    repo: String,
    index: u32,
) -> Result<GitOpResult, String> {
    let (dir, _lock) = locked(&state, &repo).await?;
    announced(&app, &repo, stash_drop(&dir, index).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_test_support::{fixture, git, TempDir};

    fn write_file(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }
    fn read_file(dir: &Path, rel: &str) -> String {
        std::fs::read_to_string(dir.join(rel)).unwrap()
    }
    fn save(dir: &Path, rel: &str, text: &str, message: &str) {
        write_file(dir, rel, text);
        git(dir, &["add", "--", rel]);
        git(dir, &["commit", "-q", "-m", message]);
    }
    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn entry<'a>(list: &'a [GitFileEntry], path: &str) -> &'a GitFileEntry {
        list.iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("{path} missing from {list:?}"))
    }
    /// The folder named by a result's "Recovery copy saved to" line.
    fn recovery(result: &GitOpResult) -> PathBuf {
        let line = result
            .output
            .lines()
            .find_map(|l| l.strip_prefix("Recovery copy saved to "))
            .expect("recovery note");
        PathBuf::from(line)
    }
    fn unborn() -> (TempDir, PathBuf) {
        let root = TempDir::new().unwrap();
        let repo = root.path().join("fresh");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.name", "You"]);
        git(&repo, &["config", "user.email", "you@example.com"]);
        (root, repo)
    }
    /// A patch carrying only hunk `index` of `file`, as the frontend builds it.
    fn hunk_patch(file: &DiffFile, index: usize) -> String {
        let hunk = &file.hunks[index];
        let mut out = format!(
            "diff --git a/{0} b/{0}\n--- a/{0}\n+++ b/{0}\n@@ -{1},{2} +{3},{4} @@\n",
            file.new_path, hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        );
        for line in &hunk.lines {
            let sign = match line.kind {
                review::DiffLineKind::Add => '+',
                review::DiffLineKind::Del => '-',
                review::DiffLineKind::Context => ' ',
            };
            out.push(sign);
            out.push_str(&line.text);
            out.push('\n');
        }
        out
    }

    #[tokio::test]
    async fn status_reads_every_file_state_and_the_branch_header() {
        let (_root, local, _) = fixture();
        save(&local, "move.txt", "move me\n", "Move");
        save(&local, "del.txt", "delete me\n", "Delete");
        write_file(&local, "shared.txt", "edited\n");
        git(&local, &["mv", "move.txt", "moved.txt"]);
        git(&local, &["rm", "-q", "del.txt"]);
        write_file(&local, "added.txt", "staged\n");
        git(&local, &["add", "added.txt"]);
        write_file(&local, "added.txt", "staged then edited\n");
        write_file(&local, "dir/sp ace.txt", "untracked\n");
        let s = status(&local).await.unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.head, Some(git(&local, &["rev-parse", "HEAD"])));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 0));
        assert_eq!(s.in_progress, None);
        let moved = entry(&s.staged, "moved.txt");
        assert_eq!(
            (moved.status.as_str(), moved.old_path.as_deref()),
            ("R", Some("move.txt"))
        );
        assert_eq!(entry(&s.staged, "del.txt").status, "D");
        assert_eq!(entry(&s.staged, "added.txt").status, "A");
        assert_eq!(entry(&s.unstaged, "added.txt").status, "M");
        assert_eq!(entry(&s.unstaged, "shared.txt").status, "M");
        assert_eq!(entry(&s.unstaged, "dir/sp ace.txt").status, "?");
        assert!(s.conflicted.is_empty());
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json["staged"][0].get("oldPath").is_some(),
            s.staged[0].old_path.is_some()
        );
        assert!(json.get("inProgress").is_some());
    }

    #[tokio::test]
    async fn status_handles_detached_and_unborn_heads() {
        let (_root, local, _) = fixture();
        git(&local, &["switch", "-q", "--detach", "HEAD"]);
        let s = status(&local).await.unwrap();
        assert_eq!(s.branch, None);
        assert!(s.head.is_some());
        let (_root, fresh) = unborn();
        let s = status(&fresh).await.unwrap();
        assert_eq!(
            (s.branch.as_deref(), s.head.as_deref()),
            (Some("main"), None)
        );
        write_file(&fresh, "first.txt", "hi\n");
        stage(&fresh, &strings(&["first.txt"])).await.unwrap();
        let s = status(&fresh).await.unwrap();
        assert_eq!(entry(&s.staged, "first.txt").status, "A");
        let diff = file_diff(&fresh, "first.txt", "staged")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(diff.status, review::FileStatus::Added);
        assert_eq!(log(&fresh, 0, 50, false).await.unwrap().len(), 0);
        assert_eq!(log(&fresh, 0, 50, true).await.unwrap().len(), 0);
        assert_eq!(last_message(&fresh).await.unwrap(), "");
        // Unborn unstage drops the entry instead of restoring from HEAD.
        unstage(&fresh, &strings(&["first.txt"])).await.unwrap();
        let s = status(&fresh).await.unwrap();
        assert!(s.staged.is_empty());
        assert_eq!(entry(&s.unstaged, "first.txt").status, "?");
    }

    #[tokio::test]
    async fn file_diffs_cover_untracked_binary_renamed_and_conflicted_paths() {
        let (_root, local, _) = fixture();
        write_file(&local, "new file.txt", "a\nb\n");
        let diff = file_diff(&local, "new file.txt", "unstaged")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(diff.status, review::FileStatus::Added);
        assert_eq!(diff.new_path, "new file.txt");
        assert_eq!(diff.hunks[0].lines.len(), 2);
        std::fs::write(local.join("blob.bin"), [0u8, 159, 146, 150, 0, 1]).unwrap();
        let diff = file_diff(&local, "blob.bin", "unstaged")
            .await
            .unwrap()
            .unwrap();
        assert!(diff.binary);
        git(&local, &["mv", "shared.txt", "renamed.txt"]);
        let diff = file_diff(&local, "renamed.txt", "staged")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(diff.status, review::FileStatus::Renamed);
        assert_eq!(diff.old_path, "shared.txt");
        assert!(file_diff(&local, "missing.txt", "unstaged")
            .await
            .unwrap()
            .is_none());
        assert!(file_diff(&local, "../escape", "unstaged").await.is_err());
        assert!(file_diff(&local, "/etc/hosts", "staged").await.is_err());
        assert!(file_diff(&local, "x", "sideways").await.is_err());
    }

    #[tokio::test]
    async fn stage_unstage_and_discard_with_recovery_copies() {
        let (_root, local, _) = fixture();
        save(&local, "keep.txt", "keep\n", "Keep");
        write_file(&local, "shared.txt", "edited\n");
        git(&local, &["rm", "-q", "keep.txt"]);
        git(&local, &["reset", "-q"]);
        write_file(&local, "[odd].txt", "untracked\n");
        stage(&local, &strings(&["shared.txt", "keep.txt", "[odd].txt"]))
            .await
            .unwrap();
        let s = status(&local).await.unwrap();
        assert_eq!(entry(&s.staged, "keep.txt").status, "D");
        assert_eq!(entry(&s.staged, "[odd].txt").status, "A");
        assert!(s.unstaged.is_empty());
        unstage(&local, &strings(&["shared.txt", "keep.txt", "[odd].txt"]))
            .await
            .unwrap();
        assert!(status(&local).await.unwrap().staged.is_empty());
        // A staged rename unstages as a pair.
        git(&local, &["checkout", "-q", "--", "keep.txt"]);
        git(&local, &["mv", "keep.txt", "kept.txt"]);
        unstage(&local, &strings(&["kept.txt"])).await.unwrap();
        let s = status(&local).await.unwrap();
        assert!(s.staged.is_empty(), "{:?}", s.staged);
        std::fs::rename(local.join("kept.txt"), local.join("keep.txt")).unwrap();

        let result = discard(&local, &strings(&["shared.txt", "[odd].txt"]))
            .await
            .unwrap();
        assert_eq!(read_file(&local, "shared.txt"), "one\n");
        assert!(!local.join("[odd].txt").exists());
        let folder = recovery(&result);
        assert!(folder.starts_with(local.join(".git/redline-undo")));
        assert_eq!(read_file(&folder, "files/shared.txt"), "edited\n");
        assert_eq!(read_file(&folder, "files/[odd].txt"), "untracked\n");
        let meta: serde_json::Value =
            serde_json::from_str(&read_file(&folder, "meta.json")).unwrap();
        assert_eq!(meta["op"], "discard");
        assert!(status(&local).await.unwrap().unstaged.is_empty());
        assert!(stage(&local, &[]).await.is_err());
        assert!(discard(&local, &strings(&["../outside"])).await.is_err());
    }

    #[tokio::test]
    async fn apply_patch_moves_one_hunk_between_index_and_worktree() {
        let (_root, local, _) = fixture();
        let body: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        save(&local, "long.txt", &body, "Long");
        let edited = body
            .replace("line 2\n", "line two\n")
            .replace("line 19\n", "line nineteen\n");
        write_file(&local, "long.txt", &edited);
        let diff = file_diff(&local, "long.txt", "unstaged")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(diff.hunks.len(), 2);
        let first = hunk_patch(&diff, 0);
        apply_patch(&local, &first, "index", false).await.unwrap();
        let staged = file_diff(&local, "long.txt", "staged")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(staged.hunks.len(), 1);
        assert!(staged.hunks[0].lines.iter().any(|l| l.text == "line two"));
        let unstaged = file_diff(&local, "long.txt", "unstaged")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unstaged.hunks.len(), 1);
        // Unstage the hunk again: the same patch, reversed, against the index.
        apply_patch(&local, &first, "index", true).await.unwrap();
        assert!(file_diff(&local, "long.txt", "staged")
            .await
            .unwrap()
            .is_none());
        // Discard only the second hunk from the worktree.
        let diff = file_diff(&local, "long.txt", "unstaged")
            .await
            .unwrap()
            .unwrap();
        let second = hunk_patch(&diff, 1);
        let result = apply_patch(&local, second.trim_end(), "worktree", true)
            .await
            .unwrap();
        assert_eq!(
            read_file(&local, "long.txt"),
            body.replace("line 2\n", "line two\n")
        );
        assert_eq!(read_file(&recovery(&result), "files/long.txt"), edited);
        assert!(apply_patch(&local, "", "index", false).await.is_err());
        assert!(apply_patch(&local, &first, "elsewhere", false)
            .await
            .is_err());
        // The index never held the first hunk, so reversing it there fails.
        let refused = apply_patch(&local, &first, "index", true)
            .await
            .unwrap_err();
        assert!(refused.contains("patch"), "{refused}");
    }

    #[tokio::test]
    async fn commit_amend_and_last_message() {
        let (_root, local, _) = fixture();
        let parent = git(&local, &["rev-parse", "HEAD"]);
        assert!(commit(&local, "  \n", false).await.is_err());
        let nothing = commit(&local, "Empty", false).await.unwrap_err();
        assert!(nothing.contains("nothing"), "{nothing}");
        write_file(&local, "shared.txt", "two\n");
        stage(&local, &strings(&["shared.txt"])).await.unwrap();
        commit(&local, "Second\n\nWith a body", false)
            .await
            .unwrap();
        assert_eq!(last_message(&local).await.unwrap(), "Second\n\nWith a body");
        commit(&local, "Second, amended", true).await.unwrap();
        assert_eq!(
            git(&local, &["log", "-1", "--format=%s"]),
            "Second, amended"
        );
        assert_eq!(git(&local, &["rev-parse", "HEAD~1"]), parent);
        assert!(status(&local).await.unwrap().staged.is_empty());
    }

    #[tokio::test]
    async fn log_reads_parents_decorations_merges_and_tags_without_stashes() {
        let (_root, local, _) = fixture();
        let root_sha = git(&local, &["rev-parse", "HEAD"]);
        git(&local, &["switch", "-q", "-c", "feature"]);
        save(&local, "feature.txt", "f\n", "Feature work");
        git(&local, &["switch", "-q", "main"]);
        save(&local, "main.txt", "m\n", "Main work");
        git(&local, &["merge", "-q", "--no-ff", "--no-edit", "feature"]);
        git(&local, &["tag", "-a", "v1", "-m", "Release"]);
        git(&local, &["tag", "light"]);
        write_file(&local, "shared.txt", "stashed\n");
        git(&local, &["stash", "push", "-q", "-m", "parked"]);
        let commits = log(&local, 0, 500, true).await.unwrap();
        assert_eq!(commits.len(), 4, "{commits:?}");
        let merge = &commits[0];
        assert_eq!(merge.parents.len(), 2);
        assert!(merge.subject.starts_with("Merge branch 'feature'"));
        assert_eq!(merge.author_email, "you@example.com");
        assert!(merge.date > 0);
        let kinds: Vec<(&str, &str)> = merge
            .refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str()))
            .collect();
        assert!(kinds.contains(&("main", "head")), "{kinds:?}");
        assert!(kinds.contains(&("v1", "tag")));
        assert!(kinds.contains(&("light", "tag")));
        assert!(!kinds.iter().any(|(_, k)| *k == "local"));
        let first = commits.iter().find(|c| c.sha == root_sha).unwrap();
        assert!(first.parents.is_empty());
        assert!(first.refs.contains(&GitRefDecoration {
            name: "origin/main".into(),
            kind: "remote".into()
        }));
        assert!(commits.iter().any(|c| c
            .refs
            .iter()
            .any(|r| r.name == "feature" && r.kind == "local")));
        assert!(!commits.iter().any(|c| c.subject.contains("parked")));
        let page = log(&local, 1, 1, false).await.unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].sha, commits[1].sha);

        let detail = commit_detail(&local, &merge.sha).await.unwrap();
        assert_eq!(detail.commit.parents, merge.parents);
        assert_eq!(detail.committer_name, "You");
        assert!(detail.committer_date > 0);
        let json = serde_json::to_value(&detail).unwrap();
        assert!(json.get("authorName").is_some() && json.get("committerDate").is_some());
        let files = commit_files(&local, &root_sha).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, review::FileStatus::Added);
        let files = commit_files(&local, &merge.sha).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].new_path, "feature.txt");

        git(&local, &["switch", "-q", "--detach", &root_sha]);
        let commits = log(&local, 0, 10, false).await.unwrap();
        assert!(commits[0].refs.contains(&GitRefDecoration {
            name: "HEAD".into(),
            kind: "head".into()
        }));
    }

    #[test]
    fn decorations_classify_by_full_refname() {
        let refs = parse_decorations(
            "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/heads/origin/x, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/stash",
        );
        let pairs: Vec<(&str, &str)> = refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("main", "head"),
                ("v1", "tag"),
                ("origin/x", "local"),
                ("origin/main", "remote")
            ]
        );
        assert!(parse_decorations("").is_empty());
    }

    #[tokio::test]
    async fn refs_report_tracking_gone_upstreams_tags_and_stashes() {
        let (_root, local, team) = fixture();
        save(&local, "ours.txt", "ours\n", "Ours");
        save(&team, "theirs.txt", "theirs\n", "Theirs");
        git(&team, &["push", "-q"]);
        git(&local, &["switch", "-q", "-c", "topic"]);
        git(&local, &["push", "-q", "-u", "origin", "topic"]);
        git(&local, &["switch", "-q", "main"]);
        git(&team, &["push", "-q", "origin", "--delete", "topic"]);
        fetch(&local).await.unwrap();
        git(&local, &["tag", "-a", "v2", "-m", "annotated"]);
        write_file(&local, "shared.txt", "parked\n");
        stash_save(&local, "parked work", false).await.unwrap();
        let r = refs(&local).await.unwrap();
        assert_eq!(r.current.as_deref(), Some("main"));
        let main = r.local.iter().find(|b| b.name == "main").unwrap();
        assert!(main.current);
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!((main.ahead, main.behind, main.gone), (1, 1, false));
        let topic = r.local.iter().find(|b| b.name == "topic").unwrap();
        assert!(topic.gone && !topic.current);
        assert_eq!(r.remotes, ["origin"]);
        assert!(r
            .remote
            .iter()
            .any(|b| b.name == "origin/main" && b.remote == "origin"));
        assert!(!r.remote.iter().any(|b| b.name.ends_with("/HEAD")));
        assert!(!r.remote.iter().any(|b| b.name == "origin/topic"));
        let tag = r.tags.iter().find(|t| t.name == "v2").unwrap();
        assert_eq!(tag.sha, git(&local, &["rev-parse", "HEAD"]));
        assert_eq!(r.stashes.len(), 1);
        assert_eq!(r.stashes[0].index, 0);
        assert!(r.stashes[0].message.contains("parked work"));
        let s = status(&local).await.unwrap();
        assert_eq!((s.ahead, s.behind), (1, 1));
    }

    #[tokio::test]
    async fn merge_conflicts_are_listed_then_abort_or_continue() {
        let (_root, local, team) = fixture();
        save(&team, "shared.txt", "theirs\n", "Theirs");
        git(&team, &["push", "-q"]);
        save(&local, "shared.txt", "ours\n", "Ours");
        write_file(&local, "notes.txt", "untracked survives\n");
        fetch(&local).await.unwrap();
        let head = git(&local, &["rev-parse", "HEAD"]);
        let result = merge(&local, "origin/main", false).await.unwrap();
        assert_eq!(result.conflicts, ["shared.txt"]);
        assert!(result.output.contains("CONFLICT"));
        let s = status(&local).await.unwrap();
        assert_eq!(s.in_progress.as_deref(), Some("merge"));
        assert_eq!(entry(&s.conflicted, "shared.txt").status, "U");
        let diff = file_diff(&local, "shared.txt", "unstaged")
            .await
            .unwrap()
            .unwrap();
        assert!(diff.hunks[0]
            .lines
            .iter()
            .any(|l| l.text.starts_with("<<<<<<<")));
        abort_op(&local).await.unwrap();
        assert_eq!(git(&local, &["rev-parse", "HEAD"]), head);
        let s = status(&local).await.unwrap();
        assert_eq!(s.in_progress, None);
        assert!(s.conflicted.is_empty() && s.staged.is_empty());
        assert_eq!(read_file(&local, "notes.txt"), "untracked survives\n");
        assert!(abort_op(&local).await.is_err());

        merge(&local, "origin/main", false).await.unwrap();
        write_file(&local, "shared.txt", "both\n");
        stage(&local, &strings(&["shared.txt"])).await.unwrap();
        continue_op(&local).await.unwrap();
        assert_eq!(status(&local).await.unwrap().in_progress, None);
        assert_eq!(
            git(&local, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .split_whitespace()
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn pull_rebase_cherry_pick_and_revert() {
        let (_root, local, team) = fixture();
        save(&team, "theirs.txt", "theirs\n", "Theirs");
        git(&team, &["push", "-q"]);
        save(&local, "ours.txt", "ours\n", "Ours");
        pull(&local, true).await.unwrap();
        assert_eq!(
            git(&local, &["rev-parse", "HEAD~1"]),
            git(&local, &["rev-parse", "origin/main"])
        );
        save(&team, "shared.txt", "team edit\n", "Team edit");
        git(&team, &["push", "-q"]);
        save(&local, "shared.txt", "local edit\n", "Local edit");
        let result = pull(&local, false).await.unwrap();
        assert_eq!(result.conflicts, ["shared.txt"]);
        abort_op(&local).await.unwrap();
        let rebased = rebase(&local, "origin/main").await.unwrap();
        assert_eq!(rebased.conflicts, ["shared.txt"]);
        assert_eq!(
            status(&local).await.unwrap().in_progress.as_deref(),
            Some("rebase")
        );
        abort_op(&local).await.unwrap();

        git(&local, &["switch", "-q", "-c", "side", "origin/main"]);
        save(&local, "side.txt", "side\n", "Side");
        let side = git(&local, &["rev-parse", "HEAD"]);
        git(&local, &["switch", "-q", "main"]);
        cherry_pick(&local, &side).await.unwrap();
        assert_eq!(read_file(&local, "side.txt"), "side\n");
        revert_commit(&local, "HEAD").await.unwrap();
        assert!(!local.join("side.txt").exists());
        assert!(git(&local, &["log", "-1", "--format=%s"]).starts_with("Revert"));
    }

    #[tokio::test]
    async fn stash_save_files_apply_pop_and_drop() {
        let (_root, local, _) = fixture();
        write_file(&local, "shared.txt", "changed\n");
        write_file(&local, "fresh.txt", "untracked\n");
        stash_save(&local, "  wip  ", true).await.unwrap();
        assert!(status(&local).await.unwrap().unstaged.is_empty());
        let files = stash_files(&local, 0).await.unwrap();
        let mut paths: Vec<&str> = files.iter().map(|f| f.new_path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["fresh.txt", "shared.txt"]);
        assert!(refs(&local).await.unwrap().stashes[0]
            .message
            .ends_with("wip"));
        stash_apply(&local, 0, false).await.unwrap();
        assert_eq!(read_file(&local, "shared.txt"), "changed\n");
        assert_eq!(refs(&local).await.unwrap().stashes.len(), 1);
        git(&local, &["reset", "-q", "--hard"]);
        git(&local, &["clean", "-q", "-f"]);
        stash_apply(&local, 0, true).await.unwrap();
        assert_eq!(read_file(&local, "fresh.txt"), "untracked\n");
        assert!(refs(&local).await.unwrap().stashes.is_empty());
        stash_save(&local, "", false).await.unwrap();
        stash_drop(&local, 0).await.unwrap();
        assert!(refs(&local).await.unwrap().stashes.is_empty());
        assert!(stash_drop(&local, 0).await.is_err());
        assert!(stash_files(&local, 3).await.is_err());
    }

    #[tokio::test]
    async fn stash_apply_conflicts_are_listed() {
        let (_root, local, _) = fixture();
        write_file(&local, "shared.txt", "stashed\n");
        stash_save(&local, "wip", false).await.unwrap();
        save(&local, "shared.txt", "committed\n", "Diverge");
        let result = stash_apply(&local, 0, true).await.unwrap();
        assert_eq!(result.conflicts, ["shared.txt"]);
        // A conflicted pop keeps the stash.
        assert_eq!(refs(&local).await.unwrap().stashes.len(), 1);
    }

    #[tokio::test]
    async fn branches_create_delete_and_checkout() {
        let (_root, local, team) = fixture();
        branch_create(&local, "feature/x", None, false)
            .await
            .unwrap();
        assert_eq!(current_branch(&local).await.as_deref(), Some("main"));
        branch_create(&local, "work", Some("HEAD"), true)
            .await
            .unwrap();
        assert_eq!(current_branch(&local).await.as_deref(), Some("work"));
        let refused = branch_delete(&local, "work", false).await.unwrap_err();
        assert!(refused.contains("checked out"));
        save(&local, "work.txt", "w\n", "Work");
        checkout(&local, "main", "branch").await.unwrap();
        let unmerged = branch_delete(&local, "work", false).await.unwrap_err();
        assert!(unmerged.contains("not fully merged"), "{unmerged}");
        branch_delete(&local, "work", true).await.unwrap();
        branch_delete(&local, "feature/x", false).await.unwrap();
        assert!(branch_create(&local, "bad name", None, false)
            .await
            .is_err());
        assert!(branch_create(&local, "@{-1}", None, false).await.is_err());
        assert!(branch_create(&local, "ok", Some("no-such-ref"), false)
            .await
            .is_err());
        assert!(checkout(&local, "nope", "branch").await.is_err());

        git(&team, &["switch", "-q", "-c", "remote-topic"]);
        save(&team, "topic.txt", "t\n", "Topic");
        git(&team, &["push", "-q", "-u", "origin", "remote-topic"]);
        fetch(&local).await.unwrap();
        checkout(&local, "origin/remote-topic", "remote")
            .await
            .unwrap();
        let r = refs(&local).await.unwrap();
        assert_eq!(r.current.as_deref(), Some("remote-topic"));
        let topic = r.local.iter().find(|b| b.name == "remote-topic").unwrap();
        assert_eq!(topic.upstream.as_deref(), Some("origin/remote-topic"));
        checkout(&local, "main", "branch").await.unwrap();
        // Already tracked locally: switches instead of failing.
        checkout(&local, "origin/remote-topic", "remote")
            .await
            .unwrap();
        assert_eq!(
            current_branch(&local).await.as_deref(),
            Some("remote-topic")
        );
        checkout(&local, "HEAD~1", "commit").await.unwrap();
        assert_eq!(status(&local).await.unwrap().branch, None);
        assert!(checkout(&local, "main", "sideways").await.is_err());
    }

    #[tokio::test]
    async fn push_publishes_and_sets_upstream() {
        let (_root, local, team) = fixture();
        git(&local, &["switch", "-q", "-c", "shipping"]);
        save(&local, "ship.txt", "s\n", "Ship");
        push_branch(&local, "origin", "shipping", true, false)
            .await
            .unwrap();
        assert_eq!(
            git(
                &local,
                &["rev-parse", "--abbrev-ref", "shipping@{upstream}"]
            ),
            "origin/shipping"
        );
        git(&team, &["fetch", "-q"]);
        assert_eq!(
            git(&team, &["rev-parse", "origin/shipping"]),
            git(&local, &["rev-parse", "HEAD"])
        );
        commit(&local, "Ship, amended", true).await.unwrap();
        let rejected = push_branch(&local, "origin", "shipping", false, false)
            .await
            .unwrap_err();
        assert!(rejected.contains("rejected"), "{rejected}");
        push_branch(&local, "origin", "shipping", false, true)
            .await
            .unwrap();
        assert!(push_branch(&local, "elsewhere", "shipping", false, false)
            .await
            .unwrap_err()
            .contains("not a configured remote"));
    }

    #[tokio::test]
    async fn reset_soft_mixed_and_hard_with_recovery() {
        let (_root, local, _) = fixture();
        let first = git(&local, &["rev-parse", "HEAD"]);
        save(&local, "shared.txt", "two\n", "Two");
        reset(&local, &first, "soft").await.unwrap();
        assert_eq!(
            entry(&status(&local).await.unwrap().staged, "shared.txt").status,
            "M"
        );
        reset(&local, "HEAD", "mixed").await.unwrap();
        let s = status(&local).await.unwrap();
        assert!(s.staged.is_empty());
        assert_eq!(entry(&s.unstaged, "shared.txt").status, "M");
        // The target commit tracks `later.txt`; the untracked copy here
        // would be clobbered, so it is saved too.
        git(&local, &["stash", "push", "-q"]);
        save(&local, "later.txt", "tracked later\n", "Later");
        let later = git(&local, &["rev-parse", "HEAD"]);
        git(&local, &["reset", "-q", "--hard", &first]);
        git(&local, &["stash", "pop", "-q"]);
        write_file(&local, "later.txt", "untracked here\n");
        let result = reset(&local, &later, "hard").await.unwrap();
        assert_eq!(read_file(&local, "shared.txt"), "one\n");
        assert_eq!(read_file(&local, "later.txt"), "tracked later\n");
        let folder = recovery(&result);
        assert_eq!(read_file(&folder, "files/shared.txt"), "two\n");
        assert_eq!(read_file(&folder, "files/later.txt"), "untracked here\n");
        assert!(reset(&local, "HEAD", "sideways").await.is_err());
    }

    #[tokio::test]
    async fn tags_create_and_delete() {
        let (_root, local, _) = fixture();
        tag_create(&local, "v1", "HEAD", Some("Release one"))
            .await
            .unwrap();
        tag_create(&local, "light", "HEAD", None).await.unwrap();
        tag_create(&local, "blank", "HEAD", Some("  "))
            .await
            .unwrap();
        assert_eq!(git(&local, &["cat-file", "-t", "v1"]), "tag");
        assert_eq!(git(&local, &["cat-file", "-t", "light"]), "commit");
        assert_eq!(git(&local, &["cat-file", "-t", "blank"]), "commit");
        tag_delete(&local, "light").await.unwrap();
        assert_eq!(refs(&local).await.unwrap().tags.len(), 2);
        assert!(tag_create(&local, "bad..name", "HEAD", None).await.is_err());
    }

    #[tokio::test]
    async fn option_shaped_names_never_reach_git() {
        let (_root, local, _) = fixture();
        let bad = "--upload-pack=x";
        let refs_before = git(&local, &["show-ref"]);
        assert!(branch_create(&local, bad, None, false).await.is_err());
        assert!(branch_create(&local, "ok", Some(bad), false).await.is_err());
        assert!(branch_delete(&local, bad, true).await.is_err());
        for kind in ["branch", "remote", "commit"] {
            assert!(checkout(&local, bad, kind).await.is_err());
        }
        assert!(merge(&local, bad, false).await.is_err());
        assert!(rebase(&local, bad).await.is_err());
        assert!(cherry_pick(&local, bad).await.is_err());
        assert!(revert_commit(&local, bad).await.is_err());
        assert!(reset(&local, bad, "hard").await.is_err());
        assert!(tag_create(&local, bad, "HEAD", None).await.is_err());
        assert!(tag_create(&local, "t", bad, None).await.is_err());
        assert!(tag_delete(&local, bad).await.is_err());
        assert!(push_branch(&local, bad, "main", false, false)
            .await
            .is_err());
        assert!(push_branch(&local, "origin", bad, false, false)
            .await
            .is_err());
        assert!(commit_detail(&local, bad).await.is_err());
        assert!(commit_files(&local, bad).await.is_err());
        // A flag-shaped path is a literal pathspec after `--`, never an option.
        let err = stage(&local, &strings(&[bad])).await.unwrap_err();
        assert!(err.contains("did not match"), "{err}");
        assert_eq!(git(&local, &["show-ref"]), refs_before);
    }

    #[test]
    fn status_parser_reads_porcelain_v2_records() {
        let out = "# branch.oid (initial)\0# branch.head (detached)\0\
                   2 R. N... 100644 100644 100644 abc abc R100 new name.txt\0old name.txt\0\
                   u UU N... 100644 100644 100644 100644 a b c both.txt\0\
                   1 .M N... 100644 100644 100644 abc abc file.txt\0? new.txt\0! ignored\0";
        let s = parse_status(out);
        assert_eq!((s.branch.as_deref(), s.head.as_deref()), (None, None));
        assert_eq!(
            s.staged,
            [GitFileEntry {
                path: "new name.txt".into(),
                old_path: Some("old name.txt".into()),
                status: "R".into()
            }]
        );
        assert_eq!(s.conflicted[0].path, "both.txt");
        let unstaged: Vec<(&str, &str)> = s
            .unstaged
            .iter()
            .map(|e| (e.path.as_str(), e.status.as_str()))
            .collect();
        assert_eq!(unstaged, [("file.txt", "M"), ("new.txt", "?")]);
        assert_eq!(parse_track("ahead 3, behind 2"), (3, 2, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
        assert_eq!(parse_track(""), (0, 0, false));
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Code Review surface: resolve a git diff for a known repo, parse it into
//! typed hunks the frontend renders verbatim, and store line-anchored
//! annotations. The review analog of the plan-review loop — same gesture,
//! applied to a diff.
//!
//! Deliberately separate from `code.rs`: that module is the *daemon-only*
//! whitelist fencing the untrusted browse agent, and widening it with review
//! git ops would widen that attack surface. These are Tauri commands driven by
//! the trusted local user, returning typed structures instead of raw text.
//! They still reuse the same repo allowlist (`code::is_known_project`) and
//! token guard (`code::safe_token`), so a review can only target a known repo.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::code;
use crate::db::Database;
use crate::state::{now_millis, CodeReviewSession, ReviewAnnotation};

/// Shared handle to the DB for the review commands.
#[derive(Clone)]
pub struct ReviewState {
    pub db: Arc<Database>,
}

impl ReviewState {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

// --- diff types (mirrored in src/types.ts) ---------------------------------

/// Which diff the reviewer wants to see. `VsBase`/`CommitSha` take their ref
/// via the separate `base`/`sha` command args (kept out of the enum so the
/// frontend can pass a plain string tag).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSource {
    /// Everything not yet committed: staged + unstaged + untracked (`diff HEAD`).
    Uncommitted,
    Staged,
    UnstagedPlusUntracked,
    LastCommit,
    VsBase,
    CommitSha,
}

impl DiffSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DiffSource::Uncommitted => "uncommitted",
            DiffSource::Staged => "staged",
            DiffSource::UnstagedPlusUntracked => "unstagedPlusUntracked",
            DiffSource::LastCommit => "lastCommit",
            DiffSource::VsBase => "vsBase",
            DiffSource::CommitSha => "commitSha",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// Line number on the old side; `None` for added lines.
    pub old_line: Option<u32>,
    /// Line number on the new side; `None` for deleted lines.
    pub new_line: Option<u32>,
    /// Line content WITHOUT the leading `+`/`-`/space sign.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// The `@@ … @@` trailer (enclosing function/context), possibly empty.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub old_path: String,
    pub new_path: String,
    pub status: FileStatus,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub committed_at: i64,
}

// --- git plumbing -----------------------------------------------------------

/// Run git and return RAW stdout (no trim — trailing/blank diff lines are
/// content), tolerating the exit codes in `ok_codes`. `git diff --no-index`
/// exits 1 when the files differ, which `worktree::git` would treat as failure.
/// `--no-optional-locks` so the staleness poll (and any diff resolve) never
/// takes the index lock out from under the agent mid-edit.
async fn git_raw(dir: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String, String> {
    let output = tokio::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(dir)
        .arg("--no-optional-locks")
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let code = output.status.code().unwrap_or(-1);
    if code == 0 || ok_codes.contains(&code) {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Untracked paths from `status --porcelain` (`?? ` rows), git-quoting stripped.
async fn untracked_paths(dir: &Path) -> Result<Vec<String>, String> {
    let out = git_raw(dir, &["status", "--porcelain"], &[]).await?;
    Ok(out
        .lines()
        .filter_map(|l| l.strip_prefix("?? "))
        .map(|p| p.trim_matches('"').to_string())
        .filter(|p| !p.is_empty())
        .collect())
}

/// The diff of one untracked file, via a read-only `--no-index` pass against
/// /dev/null (`git add -N` would be a write; `git diff` alone never shows
/// untracked files). Exit 1 = "differs", i.e. the normal case.
async fn untracked_diff(dir: &Path, path: &str) -> Result<String, String> {
    git_raw(
        dir,
        &["diff", "--no-index", "-U3", "--no-color", "--", "/dev/null", path],
        &[1],
    )
    .await
}

/// Resolve a `DiffSource` to raw unified-diff text.
async fn resolve_diff_text(
    dir: &Path,
    source: DiffSource,
    base: Option<&str>,
    sha: Option<&str>,
) -> Result<String, String> {
    let mut text = match source {
        DiffSource::Uncommitted => git_raw(dir, &["diff", "-U3", "--no-color", "HEAD"], &[]).await?,
        DiffSource::Staged => git_raw(dir, &["diff", "-U3", "--no-color", "--cached"], &[]).await?,
        DiffSource::UnstagedPlusUntracked => {
            git_raw(dir, &["diff", "-U3", "--no-color"], &[]).await?
        }
        DiffSource::LastCommit => {
            match git_raw(dir, &["diff", "-U3", "--no-color", "HEAD~1", "HEAD"], &[]).await {
                Ok(t) => t,
                // Root commit has no parent — show the commit itself instead.
                Err(_) => git_raw(dir, &["show", "--format=", "-U3", "--no-color", "HEAD"], &[]).await?,
            }
        }
        DiffSource::VsBase => {
            let b = code::safe_token(base.ok_or("vsBase requires a base ref")?)?;
            // Three-dot = diff from the merge base, i.e. PR semantics.
            let range = format!("{b}...HEAD");
            git_raw(dir, &["diff", "-U3", "--no-color", &range], &[]).await?
        }
        DiffSource::CommitSha => {
            let s = code::safe_token(sha.ok_or("commitSha requires a sha")?)?;
            git_raw(dir, &["show", "--format=", "-U3", "--no-color", s], &[]).await?
        }
    };
    // Untracked files exist only in the working tree, so only working-tree
    // sources see them.
    if matches!(
        source,
        DiffSource::Uncommitted | DiffSource::UnstagedPlusUntracked
    ) {
        for p in untracked_paths(dir).await? {
            text.push_str(&untracked_diff(dir, &p).await?);
        }
    }
    Ok(text)
}

/// Validate the repo (known project + actually a git repo) and return its dir.
async fn checked_repo_dir(db: &Database, repo: &str) -> Result<PathBuf, String> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err("missing repo path".into());
    }
    if !code::is_known_project(db, repo) {
        return Err(format!(
            "`{repo}` is not one of your known projects — reviews can only target \
             projects Redline has seen"
        ));
    }
    let dir = PathBuf::from(repo);
    let inside = crate::worktree::git(&dir, &["rev-parse", "--is-inside-work-tree"])
        .await
        .map(|s| s.trim() == "true")
        .unwrap_or(false);
    if !inside {
        return Err(format!("`{repo}` is not a git repository"));
    }
    Ok(dir)
}

// --- unified-diff parser ----------------------------------------------------

/// Strip git's `a/` / `b/` path prefix (but not a real directory named `a`
/// deeper in the path). `/dev/null` passes through untouched.
fn strip_prefix(path: &str) -> String {
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
        .to_string()
}

/// Parse `@@ -a[,b] +c[,d] @@[ header]` into (old_start, old_lines, new_start,
/// new_lines, header). Lenient: returns None on anything malformed.
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, String)> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, trailer) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let parse_range = |s: &str| -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (old_start, old_lines) = parse_range(old)?;
    let (new_start, new_lines) = parse_range(new)?;
    let header = trailer.strip_prefix(' ').unwrap_or(trailer).to_string();
    Some((old_start, old_lines, new_start, new_lines, header))
}

/// Parse unified-diff text (the concatenated output of one or more git diff
/// invocations) into typed files/hunks/lines with running old/new line numbers.
/// Lenient by design: unrecognized header lines are skipped, a malformed hunk
/// ends the current file rather than erroring — the surface renders what it
/// can rather than refusing a whole review over one odd file.
pub fn parse_unified_diff(text: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut lines = text.lines().peekable();

    while let Some(line) = lines.next() {
        let Some(rest) = line.strip_prefix("diff --git ") else {
            continue;
        };
        // Provisional paths from the `diff --git a/X b/Y` line — only used when
        // no `---`/`+++`/rename headers follow (binary or rename-only blocks).
        // Names with spaces make this split ambiguous; header lines override.
        let (mut old_path, mut new_path) = split_diff_git_paths(rest);
        let mut status: Option<FileStatus> = None;
        let mut binary = false;
        let mut hunks: Vec<DiffHunk> = Vec::new();

        // Header lines until the first hunk / next file.
        while let Some(&peek) = lines.peek() {
            if peek.starts_with("diff --git ") {
                break;
            }
            if peek.starts_with("@@ -") {
                break;
            }
            let header = lines.next().unwrap();
            if let Some(p) = header.strip_prefix("--- ") {
                old_path = strip_prefix(p);
            } else if let Some(p) = header.strip_prefix("+++ ") {
                new_path = strip_prefix(p);
            } else if let Some(p) = header.strip_prefix("rename from ") {
                old_path = p.to_string();
                status = Some(FileStatus::Renamed);
            } else if let Some(p) = header.strip_prefix("rename to ") {
                new_path = p.to_string();
                status = Some(FileStatus::Renamed);
            } else if header.starts_with("new file mode") {
                status = Some(FileStatus::Added);
            } else if header.starts_with("deleted file mode") {
                status = Some(FileStatus::Deleted);
            } else if header.starts_with("Binary files") || header.starts_with("GIT binary patch") {
                binary = true;
            }
        }

        // Hunks.
        while let Some(&peek) = lines.peek() {
            if !peek.starts_with("@@ -") {
                break;
            }
            let hline = lines.next().unwrap();
            let Some((old_start, old_lines, new_start, new_lines, header)) =
                parse_hunk_header(hline)
            else {
                break;
            };
            let mut hunk = DiffHunk {
                old_start,
                old_lines,
                new_start,
                new_lines,
                header,
                lines: Vec::new(),
            };
            let (mut old_no, mut new_no) = (old_start, new_start);
            let (mut old_left, mut new_left) = (old_lines, new_lines);
            while old_left > 0 || new_left > 0 {
                let Some(&body) = lines.peek() else { break };
                let (kind, text) = match body.chars().next() {
                    Some('+') => (DiffLineKind::Add, &body[1..]),
                    Some('-') => (DiffLineKind::Del, &body[1..]),
                    Some(' ') => (DiffLineKind::Context, &body[1..]),
                    // "\ No newline at end of file" — metadata, not a line.
                    Some('\\') => {
                        lines.next();
                        continue;
                    }
                    // Some tools emit a truly empty line for empty context.
                    None => (DiffLineKind::Context, ""),
                    _ => break,
                };
                lines.next();
                let (old_line, new_line) = match kind {
                    DiffLineKind::Add => {
                        new_left = new_left.saturating_sub(1);
                        let n = new_no;
                        new_no += 1;
                        (None, Some(n))
                    }
                    DiffLineKind::Del => {
                        old_left = old_left.saturating_sub(1);
                        let o = old_no;
                        old_no += 1;
                        (Some(o), None)
                    }
                    DiffLineKind::Context => {
                        old_left = old_left.saturating_sub(1);
                        new_left = new_left.saturating_sub(1);
                        let (o, n) = (old_no, new_no);
                        old_no += 1;
                        new_no += 1;
                        (Some(o), Some(n))
                    }
                };
                hunk.lines.push(DiffLine {
                    kind,
                    old_line,
                    new_line,
                    text: text.to_string(),
                });
            }
            hunks.push(hunk);
        }

        let status = status.unwrap_or(if binary {
            FileStatus::Binary
        } else {
            FileStatus::Modified
        });
        files.push(DiffFile {
            old_path,
            new_path,
            status,
            binary,
            hunks,
        });
    }
    files
}

/// Best-effort split of the `diff --git a/X b/Y` remainder. Unambiguous for
/// paths without spaces; header lines (`---`/`+++`/rename) override the result
/// whenever they are present, which is every case except exotic binary names.
fn split_diff_git_paths(rest: &str) -> (String, String) {
    if let Some(idx) = rest.find(" b/") {
        let old = strip_prefix(&rest[..idx]);
        let new = strip_prefix(&rest[idx + 1..]);
        (old, new)
    } else {
        (rest.to_string(), rest.to_string())
    }
}

// --- content re-anchoring (review rounds) -----------------------------------

/// The lines a diff shows for one side of one file, as `(line_no, text)`,
/// ordered. Context lines exist on both sides; add-only lines exist on `new`,
/// del-only on `old`.
/// The path a file is presented (and annotated) under — the new path, except
/// a deletion only has an old path. Mirrors the frontend's `displayPath`.
pub(crate) fn display_path(file: &DiffFile) -> &str {
    if file.status == FileStatus::Deleted {
        &file.old_path
    } else {
        &file.new_path
    }
}

pub(crate) fn side_lines(file: &DiffFile, side: &str) -> Vec<(i64, String)> {
    let mut out = Vec::new();
    for h in &file.hunks {
        for l in &h.lines {
            let no = if side == "old" { l.old_line } else { l.new_line };
            if let Some(no) = no {
                out.push((no as i64, l.text.clone()));
            }
        }
    }
    out
}

/// Find `quoted` (one or more consecutive lines) in `lines`, returning the
/// matched `(start_line, end_line)`. Two tiers, mirroring plan review's
/// self-heal: exact text match first, then whitespace-trimmed. `hint` breaks
/// ties toward the annotation's previous location when the text appears more
/// than once.
pub(crate) fn relocate_quoted(lines: &[(i64, String)], quoted: &str, hint: i64) -> Option<(i64, i64)> {
    let needle: Vec<&str> = quoted.lines().collect();
    if needle.is_empty() {
        return None;
    }
    let find = |trim: bool| -> Vec<(i64, i64)> {
        let mut hits = Vec::new();
        if lines.len() < needle.len() {
            return hits;
        }
        'outer: for w in 0..=(lines.len() - needle.len()) {
            for (k, want) in needle.iter().enumerate() {
                let (no, have) = &lines[w + k];
                // Diff lines must also be CONSECUTIVE on this side — a window
                // spanning a hunk boundary isn't the same code.
                if k > 0 && *no != lines[w + k - 1].0 + 1 {
                    continue 'outer;
                }
                let eq = if trim {
                    have.trim() == want.trim()
                } else {
                    have == want
                };
                if !eq {
                    continue 'outer;
                }
            }
            hits.push((lines[w].0, lines[w + needle.len() - 1].0));
        }
        hits
    };
    let mut hits = find(false);
    if hits.is_empty() {
        hits = find(true);
    }
    hits.into_iter().min_by_key(|(s, _)| (s - hint).abs())
}

/// Carry every annotation of `review_id` forward onto the new round's diff:
/// re-locate each one's `quoted_text` (content identity — line numbers are a
/// hint), update its line anchor + round, and mark the rest `orphaned` (the
/// agent changed or resolved those lines; the UI surfaces them honestly
/// instead of dropping them). Resolution state rides along untouched —
/// reopen-continuity applied to lines. Returns (carried, orphaned) counts.
pub fn carry_annotations_forward(
    db: &Database,
    review_id: &str,
    new_round: i64,
    diff: &[DiffFile],
) -> Result<(usize, usize), String> {
    let annotations = db
        .list_review_annotations(review_id)
        .map_err(|e| e.to_string())?;
    let mut carried = 0;
    let mut orphaned = 0;
    for mut ann in annotations {
        if ann.round >= new_round {
            continue;
        }
        match ann.scope.as_str() {
            // Review-wide feedback has no anchor to lose.
            "general" => {
                ann.status = "carried".to_string();
                carried += 1;
            }
            // A file note survives as long as its file is still in the diff.
            "file" => {
                let present = diff.iter().any(|f| {
                    if ann.side == "old" {
                        f.old_path == ann.file_path
                    } else {
                        f.new_path == ann.file_path
                    }
                });
                if present {
                    ann.status = "carried".to_string();
                    carried += 1;
                } else {
                    ann.status = "orphaned".to_string();
                    orphaned += 1;
                }
            }
            // Line scope: content identity — re-locate the quoted text.
            _ => {
                let file = diff.iter().find(|f| {
                    if ann.side == "old" {
                        f.old_path == ann.file_path
                    } else {
                        f.new_path == ann.file_path
                    }
                });
                let relocated = file.and_then(|f| {
                    relocate_quoted(&side_lines(f, &ann.side), &ann.quoted_text, ann.start_line)
                });
                match relocated {
                    Some((start, end)) => {
                        ann.start_line = start;
                        ann.end_line = end;
                        ann.status = "carried".to_string();
                        carried += 1;
                    }
                    None => {
                        ann.status = "orphaned".to_string();
                        orphaned += 1;
                    }
                }
            }
        }
        ann.round = new_round;
        db.update_review_annotation(&ann).map_err(|e| e.to_string())?;
    }
    Ok((carried, orphaned))
}

// --- finding ingestion (AI pre-review + external annotations API) ------------

/// One incoming finding from a non-user source (the AI pre-reviewer or an
/// external tool). Everything optional except the body — placement degrades
/// gracefully: matched quote → line scope, known file → file scope, else
/// review-wide.
pub(crate) struct IncomingFinding {
    pub file: Option<String>,
    pub side: Option<String>,
    pub quoted: Option<String>,
    pub line_hint: Option<i64>,
    pub body: String,
    pub suggestion: Option<String>,
    pub label: Option<String>,
    pub blocking: Option<String>,
}

/// Next id in a prefix's `{prefix}-NNN` series (server-minted — the frontend
/// owns only the `rc-` namespace, so sources can never collide with it).
fn next_prefixed_id(existing: &[crate::state::ReviewAnnotation], prefix: &str) -> String {
    let mut max = 0u32;
    for a in existing {
        if let Some(rest) = a.id.strip_prefix(prefix).and_then(|r| r.strip_prefix('-')) {
            if let Ok(n) = rest.parse::<u32>() {
                max = max.max(n);
            }
        }
    }
    format!("{prefix}-{:03}", max + 1)
}

/// Ingest one finding as a draft annotation on `session`'s current round.
///
/// The load-bearing detail: when the finding's `quoted` text relocates into
/// the diff, `quoted_text` is set to the MATCHED DIFF LINES' actual text —
/// never the source's own copy — so the annotation re-anchors across review
/// rounds exactly like a hand-placed one.
pub(crate) fn ingest_annotation(
    db: &Database,
    session: &CodeReviewSession,
    diff: &[DiffFile],
    f: IncomingFinding,
    id_prefix: &str,
    source: &str,
) -> Result<crate::state::ReviewAnnotation, String> {
    let existing = db
        .list_review_annotations(&session.review_id)
        .map_err(|e| e.to_string())?;
    let side = match f.side.as_deref() {
        Some("old") => "old",
        _ => "new",
    };

    // Placement tiers: line (quote relocates) → file (path in diff) → general.
    let mut scope = "general";
    let mut file_path = String::new();
    let mut start_line = 0i64;
    let mut end_line = 0i64;
    let mut quoted_text = String::new();
    if let Some(fp) = f.file.as_deref().filter(|p| !p.trim().is_empty()) {
        let file = diff.iter().find(|d| {
            if side == "old" {
                d.old_path == fp
            } else {
                d.new_path == fp || (d.status == FileStatus::Deleted && d.old_path == fp)
            }
        });
        if let Some(file) = file {
            scope = "file";
            file_path = fp.to_string();
            if let Some(quoted) = f.quoted.as_deref().filter(|q| !q.trim().is_empty()) {
                let lines = side_lines(file, side);
                if let Some((start, end)) =
                    relocate_quoted(&lines, quoted, f.line_hint.unwrap_or(0))
                {
                    scope = "line";
                    start_line = start;
                    end_line = end;
                    quoted_text = lines
                        .iter()
                        .filter(|(no, _)| *no >= start && *no <= end)
                        .map(|(_, t)| t.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                }
            }
        }
    }

    let annotation = crate::state::ReviewAnnotation {
        id: next_prefixed_id(&existing, id_prefix),
        review_id: session.review_id.clone(),
        round: session.round,
        file_path,
        side: side.to_string(),
        start_line,
        end_line,
        kind: if f.suggestion.as_deref().is_some_and(|s| !s.trim().is_empty()) {
            "suggestion".to_string()
        } else {
            "comment".to_string()
        },
        body: f.body,
        suggestion_replacement: f.suggestion.filter(|s| !s.trim().is_empty()),
        quoted_text,
        status: "draft".to_string(),
        resolution: None,
        created_at: now_millis(),
        scope: scope.to_string(),
        label: f.label,
        blocking: f.blocking,
        source: source.to_string(),
    };
    db.insert_review_annotation(&annotation)
        .map_err(|e| e.to_string())?;
    Ok(annotation)
}

// --- Tauri commands ---------------------------------------------------------

#[tauri::command]
pub async fn review_diff(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    source: DiffSource,
    base: Option<String>,
    sha: Option<String>,
) -> Result<Vec<DiffFile>, String> {
    let dir = checked_repo_dir(&state.db, &repo).await?;
    let text = resolve_diff_text(&dir, source, base.as_deref(), sha.as_deref()).await?;
    Ok(parse_unified_diff(&text))
}

/// Route-facing resolver: validate the repo, resolve + parse the requested
/// diff, and return it with the canonical repo path (the session key). Used
/// by the blocking `GET /v1/reviews/start` daemon route.
pub(crate) async fn resolve_for_route(
    db: &Database,
    repo: &str,
    source: DiffSource,
    base: Option<&str>,
    sha: Option<&str>,
) -> Result<(String, Vec<DiffFile>), String> {
    let dir = checked_repo_dir(db, repo).await?;
    let text = resolve_diff_text(&dir, source, base, sha).await?;
    let canon = std::fs::canonicalize(&dir)
        .unwrap_or(dir)
        .to_string_lossy()
        .to_string();
    Ok((canon, parse_unified_diff(&text)))
}

/// Parse a `?source=` query tag ("uncommitted", "vsBase", …) — the same
/// camelCase wire form the serde enum uses.
pub(crate) fn parse_source_tag(tag: &str) -> Result<DiffSource, String> {
    serde_json::from_value(serde_json::Value::String(tag.to_string()))
        .map_err(|_| format!("unknown diff source `{tag}`"))
}

/// Open (or continue) the review session for a repo: the newest existing
/// session is re-targeted to the requested source and returned with its
/// annotations intact; a repo with no session gets a fresh round-1 row. The
/// blocking daemon route (P4) shares this so a `/redline-review` re-run and
/// the read-only pane land on the SAME review — that continuity is what the
/// round/re-anchor model rides on.
pub fn open_or_continue_review(
    db: &Database,
    repo: &str,
    source: DiffSource,
    base: Option<&str>,
    sha: Option<&str>,
) -> Result<CodeReviewSession, String> {
    let mut session = db
        .latest_code_review_for_repo(repo)
        .unwrap_or_else(|| CodeReviewSession {
            review_id: uuid::Uuid::new_v4().to_string(),
            repo_path: repo.to_string(),
            source: source.as_str().to_string(),
            base_ref: None,
            commit_sha: None,
            terminal_id: None,
            round: 1,
            created_at: now_millis(),
        });
    session.source = source.as_str().to_string();
    session.base_ref = base.map(str::to_string);
    session.commit_sha = sha.map(str::to_string);
    db.upsert_code_review(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

#[tauri::command]
pub async fn review_open(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    source: DiffSource,
    base: Option<String>,
    sha: Option<String>,
) -> Result<CodeReviewSession, String> {
    let dir = checked_repo_dir(&state.db, &repo).await?;
    // Key the session on the canonical path so the same repo reached via
    // symlink / trailing-slash variants still continues one session.
    let repo = std::fs::canonicalize(&dir)
        .unwrap_or(dir)
        .to_string_lossy()
        .to_string();
    open_or_continue_review(&state.db, &repo, source, base.as_deref(), sha.as_deref())
}

/// Cheap content fingerprint of the resolved diff text (djb2), for the
/// pane's staleness poll: "has the working tree changed under this diff?"
/// Untracked files ride along because `resolve_diff_text` already includes
/// their `--no-index` passes for working-tree sources.
#[tauri::command]
pub async fn review_fingerprint(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    source: DiffSource,
    base: Option<String>,
    sha: Option<String>,
) -> Result<String, String> {
    let dir = checked_repo_dir(&state.db, &repo).await?;
    let text = resolve_diff_text(&dir, source, base.as_deref(), sha.as_deref()).await?;
    let mut h: u64 = 5381;
    for b in text.bytes() {
        h = h.wrapping_mul(33) ^ (b as u64);
    }
    Ok(format!("{h:016x}"))
}

#[tauri::command]
pub async fn review_commits(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    n: Option<u32>,
) -> Result<Vec<ReviewCommit>, String> {
    let dir = checked_repo_dir(&state.db, &repo).await?;
    let n = n.unwrap_or(20).clamp(1, 100).to_string();
    let out = git_raw(
        &dir,
        &["log", "-n", &n, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct"],
        &[],
    )
    .await?;
    Ok(parse_commits(&out))
}

fn parse_commits(out: &str) -> Vec<ReviewCommit> {
    out.lines()
        .filter_map(|l| {
            let mut parts = l.split('\u{1f}');
            Some(ReviewCommit {
                sha: parts.next()?.to_string(),
                short_sha: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                committed_at: parts.next()?.parse().ok()?,
            })
        })
        .collect()
}

// --- expand-context file contents --------------------------------------------

/// Full-file reads for context expansion are capped — the pane only needs
/// human-scale files, and an 8 MB read per expander click is already generous.
const MAX_EXPAND_BYTES: u64 = 8 * 1024 * 1024;

/// Both sides' full content for one diff file, for context expansion. A side
/// is `None` when it has no content there (added/deleted file), the blob is
/// binary, or the ref/path can't be resolved — the pane simply can't expand
/// that side.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFileContents {
    pub old_lines: Option<Vec<String>>,
    pub new_lines: Option<Vec<String>>,
}

/// A repo-relative path from the diff: reject absolute paths, parent
/// traversal, control chars, and unreasonable length. Paths reach git inside
/// a `ref:path` spec (never as a bare argument), so flag injection isn't in
/// play — traversal out of the repo is.
fn safe_rel_path(p: &str) -> Result<&str, String> {
    if p.is_empty()
        || p.len() > 1024
        || p.starts_with('/')
        || p.contains('\\')
        || p.bytes().any(|b| b < 0x20)
        || p.split('/').any(|c| c == "..")
    {
        return Err("invalid file path".into());
    }
    Ok(p)
}

/// One side's lines from a git object (`{spec}` = `ref:path` or `:0:path`).
/// Any failure (missing in that ref, binary, non-UTF-8) → `None`.
async fn spec_content(dir: &Path, spec: &str) -> Option<Vec<String>> {
    let out = git_raw(dir, &["show", spec], &[]).await.ok()?;
    if out.as_bytes().contains(&0) {
        return None;
    }
    Some(out.lines().map(str::to_string).collect())
}

/// One side's lines from the working tree, canonicalize-prefix-checked under
/// the repo dir so a hostile path can never read outside it.
fn worktree_content(dir: &Path, path: &str) -> Option<Vec<String>> {
    let root = std::fs::canonicalize(dir).ok()?;
    let full = std::fs::canonicalize(root.join(path)).ok()?;
    if !full.starts_with(&root) {
        return None;
    }
    let meta = std::fs::metadata(&full).ok()?;
    if !meta.is_file() || meta.len() > MAX_EXPAND_BYTES {
        return None;
    }
    let bytes = std::fs::read(&full).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let s = String::from_utf8(bytes).ok()?;
    Some(s.lines().map(str::to_string).collect())
}

/// Resolve both sides of `file_path` for `source` — the same coordinates the
/// diff itself was resolved with, so the content matches what the hunks were
/// cut from (the frontend still runs a consistency check before augmenting).
async fn file_contents_for(
    dir: &Path,
    source: DiffSource,
    base: Option<&str>,
    sha: Option<&str>,
    file_path: &str,
    old_path: Option<&str>,
) -> Result<ReviewFileContents, String> {
    let path = safe_rel_path(file_path)?;
    let old_p = safe_rel_path(old_path.unwrap_or(file_path))?;
    let (old_lines, new_lines) = match source {
        DiffSource::Uncommitted => (
            spec_content(dir, &format!("HEAD:{old_p}")).await,
            worktree_content(dir, path),
        ),
        DiffSource::Staged => (
            spec_content(dir, &format!("HEAD:{old_p}")).await,
            spec_content(dir, &format!(":0:{path}")).await,
        ),
        DiffSource::UnstagedPlusUntracked => (
            spec_content(dir, &format!(":0:{old_p}")).await,
            worktree_content(dir, path),
        ),
        DiffSource::LastCommit => (
            spec_content(dir, &format!("HEAD~1:{old_p}")).await,
            spec_content(dir, &format!("HEAD:{path}")).await,
        ),
        DiffSource::VsBase => {
            let b = code::safe_token(base.ok_or("vsBase requires a base ref")?)?;
            let mb = git_raw(dir, &["merge-base", b, "HEAD"], &[])
                .await?
                .trim()
                .to_string();
            (
                spec_content(dir, &format!("{mb}:{old_p}")).await,
                spec_content(dir, &format!("HEAD:{path}")).await,
            )
        }
        DiffSource::CommitSha => {
            let s = code::safe_token(sha.ok_or("commitSha requires a sha")?)?;
            (
                spec_content(dir, &format!("{s}~1:{old_p}")).await,
                spec_content(dir, &format!("{s}:{path}")).await,
            )
        }
    };
    Ok(ReviewFileContents {
        old_lines,
        new_lines,
    })
}

#[tauri::command]
pub async fn review_file_contents(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    source: DiffSource,
    base: Option<String>,
    sha: Option<String>,
    file_path: String,
    old_path: Option<String>,
) -> Result<ReviewFileContents, String> {
    let dir = checked_repo_dir(&state.db, &repo).await?;
    file_contents_for(
        &dir,
        source,
        base.as_deref(),
        sha.as_deref(),
        &file_path,
        old_path.as_deref(),
    )
    .await
}

// --- branch enumeration -------------------------------------------------------

/// Local + remote branch names for the vsBase picker, classified on the FULL
/// refname (a `feature/foo` local branch must not read as a remote).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBranches {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub head: Option<String>,
}

/// Bound the picker for repos with pathological branch counts.
const MAX_BRANCHES: usize = 200;

pub(crate) fn parse_branches(out: &str, head: Option<String>) -> ReviewBranches {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for l in out.lines() {
        let Some((full, short)) = l.split_once('\t') else {
            continue;
        };
        if full.starts_with("refs/heads/") {
            if local.len() < MAX_BRANCHES {
                local.push(short.to_string());
            }
        } else if full.starts_with("refs/remotes/") {
            // origin/HEAD is a pointer, not a reviewable base.
            if !short.ends_with("/HEAD") && remote.len() < MAX_BRANCHES {
                remote.push(short.to_string());
            }
        }
    }
    ReviewBranches {
        local,
        remote,
        head,
    }
}

#[tauri::command]
pub async fn review_branches(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<ReviewBranches, String> {
    let dir = checked_repo_dir(&state.db, &repo).await?;
    let out = git_raw(
        &dir,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
        &[],
    )
    .await?;
    let head = git_raw(&dir, &["rev-parse", "--abbrev-ref", "HEAD"], &[])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    Ok(parse_branches(&out, head))
}

/// All review sessions, newest first — the pane's history/picker surface.
#[tauri::command]
pub fn review_sessions_list(
    state: tauri::State<'_, ReviewState>,
) -> Result<Vec<CodeReviewSession>, String> {
    state.db.list_code_reviews().map_err(|e| e.to_string())
}

/// Delete a review session outright (annotations, viewed marks, rounds) —
/// the "start over" affordance. The next `/redline-review` in that repo
/// mints a fresh round-1 session.
#[tauri::command]
pub fn review_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    review_id: String,
) -> Result<(), String> {
    state
        .db
        .delete_code_review(&review_id)
        .map_err(|e| e.to_string())?;
    emit_changed(&app, &review_id);
    Ok(())
}

/// Notify the frontend that this review's annotation set changed (any writer).
fn emit_changed(app: &tauri::AppHandle, review_id: &str) {
    if let Err(e) = app.emit("review-annotations-changed", review_id.to_string()) {
        tracing::warn!(error = %e, "failed to emit review-annotations-changed");
    }
}

#[tauri::command]
pub fn review_annotation_add(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    annotation: ReviewAnnotation,
) -> Result<(), String> {
    state
        .db
        .insert_review_annotation(&annotation)
        .map_err(|e| e.to_string())?;
    emit_changed(&app, &annotation.review_id);
    Ok(())
}

#[tauri::command]
pub fn review_annotation_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    annotation: ReviewAnnotation,
) -> Result<(), String> {
    state
        .db
        .update_review_annotation(&annotation)
        .map_err(|e| e.to_string())?;
    emit_changed(&app, &annotation.review_id);
    Ok(())
}

#[tauri::command]
pub fn review_annotation_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    review_id: String,
    id: String,
) -> Result<(), String> {
    // Cascade the annotation's discussion thread — annotation ids are reused
    // (`rc-{max+1}`), so leaving rows would resurface a deleted annotation's
    // discussion under the next annotation that inherits its id.
    state
        .db
        .delete_thread(&review_id, &id)
        .map_err(|e| e.to_string())?;
    state
        .db
        .delete_review_annotation(&review_id, &id)
        .map_err(|e| e.to_string())?;
    emit_changed(&app, &review_id);
    Ok(())
}

#[tauri::command]
pub fn review_annotation_list(
    state: tauri::State<'_, ReviewState>,
    review_id: String,
) -> Result<Vec<ReviewAnnotation>, String> {
    state
        .db
        .list_review_annotations(&review_id)
        .map_err(|e| e.to_string())
}

/// Clear one source's DRAFT annotations (the "Clear AI findings" hatch and
/// the external API's DELETE). Reviewer-authored annotations are refused —
/// `user` drafts are deleted individually, deliberately.
#[tauri::command]
pub fn review_annotation_clear_source(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    review_id: String,
    source: String,
) -> Result<usize, String> {
    if source == "user" {
        return Err("refusing to bulk-clear the reviewer's own annotations".into());
    }
    let n = state
        .db
        .clear_review_annotations_by_source(&review_id, &source)
        .map_err(|e| e.to_string())?;
    if n > 0 {
        emit_changed(&app, &review_id);
    }
    Ok(n)
}

/// Notify the frontend that this review's question set changed.
fn emit_questions_changed(app: &tauri::AppHandle, review_id: &str) {
    if let Err(e) = app.emit("review-questions-changed", review_id.to_string()) {
        tracing::warn!(error = %e, "failed to emit review-questions-changed");
    }
}

#[tauri::command]
pub fn review_question_add(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    question: crate::state::ReviewQuestion,
) -> Result<(), String> {
    state
        .db
        .insert_review_question(&question)
        .map_err(|e| e.to_string())?;
    emit_questions_changed(&app, &question.review_id);
    Ok(())
}

#[tauri::command]
pub fn review_question_list(
    state: tauri::State<'_, ReviewState>,
    review_id: String,
) -> Result<Vec<crate::state::ReviewQuestion>, String> {
    state
        .db
        .list_review_questions(&review_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn review_question_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    review_id: String,
    id: String,
) -> Result<(), String> {
    // Cascade the question's Ask-AI thread (ids are reused within `ask-`).
    state
        .db
        .delete_thread(&review_id, &id)
        .map_err(|e| e.to_string())?;
    state
        .db
        .delete_review_question(&review_id, &id)
        .map_err(|e| e.to_string())?;
    emit_questions_changed(&app, &review_id);
    Ok(())
}

#[tauri::command]
pub fn review_mark_viewed(
    state: tauri::State<'_, ReviewState>,
    review_id: String,
    file_path: String,
    viewed: bool,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if viewed {
        state.db.mark_review_viewed(&review_id, &file_path, now)
    } else {
        state.db.unmark_review_viewed(&review_id, &file_path)
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn review_list_viewed(
    state: tauri::State<'_, ReviewState>,
    review_id: String,
) -> Result<Vec<String>, String> {
    state
        .db
        .list_review_viewed(&review_id)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parser -------------------------------------------------------------

    const MODIFIED: &str = "\
diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,5 @@ fn main() {
 let a = 1;
-let b = 2;
+let b = 3;
+let c = 4;
 let d = 5;
 let e = 6;
@@ -10,2 +11,2 @@
 tail();
-old();
+new();
";

    #[test]
    fn parses_a_modified_file_with_two_hunks() {
        let files = parse_unified_diff(MODIFIED);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.old_path, "src/main.rs");
        assert_eq!(f.new_path, "src/main.rs");
        assert_eq!(f.status, FileStatus::Modified);
        assert!(!f.binary);
        assert_eq!(f.hunks.len(), 2);
        let h = &f.hunks[0];
        assert_eq!((h.old_start, h.old_lines, h.new_start, h.new_lines), (1, 4, 1, 5));
        assert_eq!(h.header, "fn main() {");
        assert_eq!(h.lines.len(), 6);
        // Line-number walk: context advances both, del only old, add only new.
        assert_eq!(h.lines[0].kind, DiffLineKind::Context);
        assert_eq!((h.lines[0].old_line, h.lines[0].new_line), (Some(1), Some(1)));
        assert_eq!(h.lines[1].kind, DiffLineKind::Del);
        assert_eq!((h.lines[1].old_line, h.lines[1].new_line), (Some(2), None));
        assert_eq!(h.lines[2].kind, DiffLineKind::Add);
        assert_eq!((h.lines[2].old_line, h.lines[2].new_line), (None, Some(2)));
        assert_eq!(h.lines[3].kind, DiffLineKind::Add);
        assert_eq!((h.lines[3].old_line, h.lines[3].new_line), (None, Some(3)));
        assert_eq!(h.lines[4].kind, DiffLineKind::Context);
        assert_eq!((h.lines[4].old_line, h.lines[4].new_line), (Some(3), Some(4)));
        // Sign is stripped from the stored text.
        assert_eq!(h.lines[1].text, "let b = 2;");
        assert_eq!(h.lines[2].text, "let b = 3;");
    }

    #[test]
    fn parses_added_file_from_no_index_pass() {
        // Exactly the shape `git diff --no-index -- /dev/null <path>` emits.
        let text = "\
diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@
+new
+file
";
        let files = parse_unified_diff(text);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.status, FileStatus::Added);
        assert_eq!(f.old_path, "/dev/null");
        assert_eq!(f.new_path, "b.txt");
        assert_eq!(f.hunks[0].lines.len(), 2);
        assert_eq!(f.hunks[0].lines[0].new_line, Some(1));
        assert_eq!(f.hunks[0].lines[0].old_line, None);
    }

    #[test]
    fn parses_deleted_renamed_and_binary_files() {
        let text = "\
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3e75765..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old-name.rs b/new-name.rs
similarity index 95%
rename from old-name.rs
rename to new-name.rs
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
";
        let files = parse_unified_diff(text);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, FileStatus::Deleted);
        assert_eq!(files[0].hunks[0].lines[0].kind, DiffLineKind::Del);
        assert_eq!(files[1].status, FileStatus::Renamed);
        assert_eq!(files[1].old_path, "old-name.rs");
        assert_eq!(files[1].new_path, "new-name.rs");
        assert!(files[1].hunks.is_empty());
        assert_eq!(files[2].status, FileStatus::Binary);
        assert!(files[2].binary);
        assert_eq!(files[2].new_path, "logo.png");
    }

    #[test]
    fn no_newline_marker_is_skipped_not_a_line() {
        let text = "\
diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
";
        let files = parse_unified_diff(text);
        let lines = &files[0].hunks[0].lines;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].kind, DiffLineKind::Del);
        assert_eq!(lines[1].kind, DiffLineKind::Add);
    }

    #[test]
    fn empty_input_and_garbage_yield_no_files() {
        assert!(parse_unified_diff("").is_empty());
        assert!(parse_unified_diff("not a diff\nat all\n").is_empty());
    }

    #[test]
    fn hunk_header_without_trailer_and_single_line_ranges() {
        let (os, ol, ns, nl, h) = parse_hunk_header("@@ -5 +7,2 @@").unwrap();
        assert_eq!((os, ol, ns, nl), (5, 1, 7, 2));
        assert_eq!(h, "");
        assert!(parse_hunk_header("@@ garbage @@").is_none());
    }

    #[test]
    fn source_tags_match_the_serde_wire_form() {
        // `as_str` values are persisted to review_sessions.source and must stay
        // in lockstep with the serde(rename_all = "camelCase") wire tags.
        for (src, tag) in [
            (DiffSource::Uncommitted, "uncommitted"),
            (DiffSource::Staged, "staged"),
            (DiffSource::UnstagedPlusUntracked, "unstagedPlusUntracked"),
            (DiffSource::LastCommit, "lastCommit"),
            (DiffSource::VsBase, "vsBase"),
            (DiffSource::CommitSha, "commitSha"),
        ] {
            assert_eq!(src.as_str(), tag);
            assert_eq!(
                serde_json::to_string(&src).unwrap(),
                format!("\"{tag}\"")
            );
        }
    }

    #[test]
    fn commit_log_lines_parse_and_malformed_rows_drop() {
        let out = "abc123\u{1f}abc\u{1f}fix: thing\u{1f}Yusuf\u{1f}1700000000\nBADLINE\n";
        let commits = parse_commits(out);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].short_sha, "abc");
        assert_eq!(commits[0].subject, "fix: thing");
        assert_eq!(commits[0].committed_at, 1_700_000_000);
    }

    // --- content re-anchoring -------------------------------------------------

    fn ann(quoted: &str, start: i64, end: i64) -> ReviewAnnotation {
        ReviewAnnotation {
            id: "rc-001".to_string(),
            review_id: "rev-1".to_string(),
            round: 1,
            file_path: "src/main.rs".to_string(),
            side: "new".to_string(),
            start_line: start,
            end_line: end,
            kind: "comment".to_string(),
            body: "note".to_string(),
            suggestion_replacement: None,
            quoted_text: quoted.to_string(),
            status: "submitted".to_string(),
            resolution: Some("Will fix".to_string()),
            created_at: 1,
            scope: "line".to_string(),
            label: None,
            blocking: None,
            source: "user".to_string(),
        }
    }

    #[test]
    fn relocate_finds_exact_then_trimmed_and_respects_the_hint() {
        let lines: Vec<(i64, String)> = vec![
            (10, "let a = 1;".into()),
            (11, "call();".into()),
            (12, "let b = 2;".into()),
            // A second identical occurrence further away:
            (40, "call();".into()),
        ];
        // Exact, single line — nearest occurrence to the hint wins.
        assert_eq!(relocate_quoted(&lines, "call();", 11), Some((11, 11)));
        assert_eq!(relocate_quoted(&lines, "call();", 38), Some((40, 40)));
        // Multi-line window must be consecutive line numbers.
        assert_eq!(
            relocate_quoted(&lines, "call();\nlet b = 2;", 0),
            Some((11, 12))
        );
        assert_eq!(relocate_quoted(&lines, "let b = 2;\ncall();", 0), None);
        // Trimmed tier: indentation changed but content survived.
        assert_eq!(relocate_quoted(&lines, "  let b = 2;  ", 0), Some((12, 12)));
        // Gone entirely → None.
        assert_eq!(relocate_quoted(&lines, "vanished();", 0), None);
        assert_eq!(relocate_quoted(&lines, "", 0), None);
    }

    #[test]
    fn relocate_never_matches_across_a_hunk_gap() {
        // 11 and 20 are both present but not consecutive — a two-line quote
        // spanning them is NOT the same code.
        let lines: Vec<(i64, String)> = vec![(11, "alpha".into()), (20, "beta".into())];
        assert_eq!(relocate_quoted(&lines, "alpha\nbeta", 0), None);
    }

    #[test]
    fn carry_forward_re_homes_matches_and_orphans_the_rest() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_code_review(&crate::state::CodeReviewSession {
            review_id: "rev-1".to_string(),
            repo_path: "/p".to_string(),
            source: "uncommitted".to_string(),
            base_ref: None,
            commit_sha: None,
            terminal_id: None,
            round: 2,
            created_at: 1,
        })
        .unwrap();
        // Round-1 annotations: one whose text survives (moved down two lines
        // in the round-2 diff), one whose text the agent rewrote.
        db.insert_review_annotation(&ann("let b = 2;", 2, 2)).unwrap();
        let mut gone = ann("obsolete();", 5, 5);
        gone.id = "rc-002".to_string();
        db.insert_review_annotation(&gone).unwrap();

        // Round-2 diff: same file, the annotated line now at new-line 4.
        let round2 = parse_unified_diff(
            "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,5 @@
 intro();
+let added = 0;
 let a = 1;
 let b = 2;
 tail();
",
        );
        let (carried, orphaned) =
            carry_annotations_forward(&db, "rev-1", 2, &round2).unwrap();
        assert_eq!((carried, orphaned), (1, 1));

        let after = db.list_review_annotations("rev-1").unwrap();
        let kept = after.iter().find(|a| a.id == "rc-001").unwrap();
        assert_eq!(kept.status, "carried");
        assert_eq!(kept.round, 2);
        assert_eq!((kept.start_line, kept.end_line), (4, 4));
        // Resolution state rides along (reopen-continuity for lines).
        assert_eq!(kept.resolution.as_deref(), Some("Will fix"));
        let orphan = after.iter().find(|a| a.id == "rc-002").unwrap();
        assert_eq!(orphan.status, "orphaned");
        assert_eq!(orphan.round, 2);

        // A second pass at the same round is a no-op (round guard).
        let (c2, o2) = carry_annotations_forward(&db, "rev-1", 2, &round2).unwrap();
        assert_eq!((c2, o2), (0, 0));
    }

    #[test]
    fn carry_forward_scopes_general_always_file_iff_present() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_code_review(&crate::state::CodeReviewSession {
            review_id: "rev-1".to_string(),
            repo_path: "/p".to_string(),
            source: "uncommitted".to_string(),
            base_ref: None,
            commit_sha: None,
            terminal_id: None,
            round: 2,
            created_at: 1,
        })
        .unwrap();
        // A review-wide note, a file note on a file still in the diff, and a
        // file note on a file the next round no longer touches.
        let mut general = ann("", 0, 0);
        general.scope = "general".to_string();
        general.file_path = String::new();
        general.quoted_text = String::new();
        db.insert_review_annotation(&general).unwrap();
        let mut kept_file = ann("", 0, 0);
        kept_file.id = "rc-002".to_string();
        kept_file.scope = "file".to_string();
        kept_file.quoted_text = String::new();
        db.insert_review_annotation(&kept_file).unwrap();
        let mut gone_file = ann("", 0, 0);
        gone_file.id = "rc-003".to_string();
        gone_file.scope = "file".to_string();
        gone_file.file_path = "src/other.rs".to_string();
        gone_file.quoted_text = String::new();
        db.insert_review_annotation(&gone_file).unwrap();

        let round2 = parse_unified_diff(
            "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,1 +1,2 @@
 intro();
+let added = 0;
",
        );
        let (carried, orphaned) =
            carry_annotations_forward(&db, "rev-1", 2, &round2).unwrap();
        assert_eq!((carried, orphaned), (2, 1));
        let after = db.list_review_annotations("rev-1").unwrap();
        let by_id = |id: &str| after.iter().find(|a| a.id == id).unwrap();
        assert_eq!(by_id("rc-001").status, "carried", "general never orphans");
        assert_eq!(by_id("rc-002").status, "carried", "file still in diff");
        assert_eq!(by_id("rc-003").status, "orphaned", "file left the diff");
    }

    #[test]
    fn ingest_places_line_file_general_and_recaptures_quoted_text() {
        let db = Database::open_in_memory().unwrap();
        let session = crate::state::CodeReviewSession {
            review_id: "rev-1".to_string(),
            repo_path: "/p".to_string(),
            source: "uncommitted".to_string(),
            base_ref: None,
            commit_sha: None,
            terminal_id: None,
            round: 3,
            created_at: 1,
        };
        db.upsert_code_review(&session).unwrap();
        let diff = parse_unified_diff(
            "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,2 +1,3 @@
 intro();
+let added = 0;
 tail();
",
        );
        let f = |file: Option<&str>, quoted: Option<&str>| IncomingFinding {
            file: file.map(str::to_string),
            side: None,
            quoted: quoted.map(str::to_string),
            line_hint: None,
            body: "finding".to_string(),
            suggestion: None,
            label: Some("issue".to_string()),
            blocking: Some("blocking".to_string()),
        };

        // Whitespace-drifted quote still relocates (trimmed tier), and the
        // stored anchor is the DIFF's text, not the model's copy.
        let line = ingest_annotation(
            &db,
            &session,
            &diff,
            f(Some("src/main.rs"), Some("  let added = 0;  ")),
            "ai",
            "ai",
        )
        .unwrap();
        assert_eq!(line.id, "ai-001");
        assert_eq!(line.scope, "line");
        assert_eq!((line.start_line, line.end_line), (2, 2));
        assert_eq!(line.quoted_text, "let added = 0;", "recaptured from the diff");
        assert_eq!(line.round, 3);
        assert_eq!(line.status, "draft");
        assert_eq!(line.source, "ai");

        // Known file, unmatchable quote → file scope; ids keep counting.
        let file_scope = ingest_annotation(
            &db,
            &session,
            &diff,
            f(Some("src/main.rs"), Some("no such code")),
            "ai",
            "ai",
        )
        .unwrap();
        assert_eq!(file_scope.id, "ai-002");
        assert_eq!(file_scope.scope, "file");
        assert_eq!(file_scope.file_path, "src/main.rs");

        // Unknown file → review-wide.
        let general =
            ingest_annotation(&db, &session, &diff, f(Some("nope.rs"), None), "ai", "ai")
                .unwrap();
        assert_eq!(general.scope, "general");
        assert_eq!(general.file_path, "");

        // A different prefix owns its own series (external tools).
        let ext = ingest_annotation(&db, &session, &diff, f(None, None), "ext", "mylinter")
            .unwrap();
        assert_eq!(ext.id, "ext-001");
        assert_eq!(ext.source, "mylinter");

        // Clear-by-source removes only that source's drafts.
        let n = db.clear_review_annotations_by_source("rev-1", "ai").unwrap();
        assert_eq!(n, 3);
        let left = db.list_review_annotations("rev-1").unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].source, "mylinter");
    }

    // --- resolver over a real temp repo --------------------------------------

    async fn run(dir: &Path, args: &[&str]) {
        let ok = tokio::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .await
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// Self-cleaning temp git repo (no `tempfile` dep — matches the
    /// `std::env::temp_dir()` + uuid convention used across this crate).
    struct TempRepo(PathBuf);
    impl TempRepo {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn temp_repo() -> TempRepo {
        let dir = std::env::temp_dir().join(format!("redline-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let td = TempRepo(dir);
        let d = td.path();
        run(d, &["init", "-q"]).await;
        run(d, &["config", "user.email", "t@t"]).await;
        run(d, &["config", "user.name", "t"]).await;
        tokio::fs::write(d.join("a.txt"), "one\ntwo\n").await.unwrap();
        run(d, &["add", "a.txt"]).await;
        run(d, &["commit", "-qm", "init"]).await;
        td
    }

    #[tokio::test]
    async fn uncommitted_source_sees_modified_and_untracked_files() {
        let td = temp_repo().await;
        let d = td.path();
        tokio::fs::write(d.join("a.txt"), "one\nTWO\n").await.unwrap();
        tokio::fs::write(d.join("new.txt"), "hello\n").await.unwrap();
        let text = resolve_diff_text(d, DiffSource::Uncommitted, None, None)
            .await
            .unwrap();
        let files = parse_unified_diff(&text);
        assert_eq!(files.len(), 2, "modified + untracked: {files:#?}");
        assert_eq!(files[0].new_path, "a.txt");
        assert_eq!(files[0].status, FileStatus::Modified);
        assert_eq!(files[1].new_path, "new.txt");
        assert_eq!(files[1].status, FileStatus::Added);
        assert_eq!(files[1].hunks[0].lines[0].text, "hello");
    }

    #[tokio::test]
    async fn staged_source_sees_only_the_index() {
        let td = temp_repo().await;
        let d = td.path();
        tokio::fs::write(d.join("a.txt"), "one\nTWO\n").await.unwrap();
        run(d, &["add", "a.txt"]).await;
        // A further unstaged edit must NOT appear in the staged diff.
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();
        let text = resolve_diff_text(d, DiffSource::Staged, None, None)
            .await
            .unwrap();
        let files = parse_unified_diff(&text);
        assert_eq!(files.len(), 1);
        let adds: Vec<_> = files[0].hunks[0]
            .lines
            .iter()
            .filter(|l| l.kind == DiffLineKind::Add)
            .collect();
        assert_eq!(adds.len(), 1);
        assert_eq!(adds[0].text, "TWO");
    }

    #[tokio::test]
    async fn last_commit_falls_back_to_show_on_root_commit() {
        let td = temp_repo().await;
        let d = td.path();
        // Only one commit exists — HEAD~1 is unresolvable.
        let text = resolve_diff_text(d, DiffSource::LastCommit, None, None)
            .await
            .unwrap();
        let files = parse_unified_diff(&text);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, FileStatus::Added);
        assert_eq!(files[0].new_path, "a.txt");
    }

    #[tokio::test]
    async fn last_commit_diffs_parent_when_history_exists() {
        let td = temp_repo().await;
        let d = td.path();
        tokio::fs::write(d.join("a.txt"), "one\ntwo\nthree\n").await.unwrap();
        run(d, &["add", "a.txt"]).await;
        run(d, &["commit", "-qm", "second"]).await;
        let text = resolve_diff_text(d, DiffSource::LastCommit, None, None)
            .await
            .unwrap();
        let files = parse_unified_diff(&text);
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].hunks[0]
                .lines
                .iter()
                .filter(|l| l.kind == DiffLineKind::Add)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn vs_base_uses_merge_base_semantics() {
        let td = temp_repo().await;
        let d = td.path();
        run(d, &["checkout", "-qb", "feature"]).await;
        tokio::fs::write(d.join("feat.txt"), "feature\n").await.unwrap();
        run(d, &["add", "feat.txt"]).await;
        run(d, &["commit", "-qm", "feat"]).await;
        let text = resolve_diff_text(d, DiffSource::VsBase, Some("main"), None)
            .await
            .or(resolve_diff_text(d, DiffSource::VsBase, Some("master"), None).await)
            .unwrap();
        let files = parse_unified_diff(&text);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].new_path, "feat.txt");
        assert_eq!(files[0].status, FileStatus::Added);
    }

    #[tokio::test]
    async fn vs_base_rejects_flag_shaped_refs() {
        let td = temp_repo().await;
        let err = resolve_diff_text(td.path(), DiffSource::VsBase, Some("--exec=evil"), None)
            .await
            .unwrap_err();
        assert!(err.contains("flag"), "{err}");
    }

    #[tokio::test]
    async fn empty_diff_resolves_to_no_files() {
        let td = temp_repo().await;
        let text = resolve_diff_text(td.path(), DiffSource::Uncommitted, None, None)
            .await
            .unwrap();
        assert!(parse_unified_diff(&text).is_empty());
    }

    #[tokio::test]
    async fn file_contents_uncommitted_reads_head_and_worktree() {
        let td = temp_repo().await;
        let d = td.path();
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();
        let c = file_contents_for(d, DiffSource::Uncommitted, None, None, "a.txt", None)
            .await
            .unwrap();
        assert_eq!(c.old_lines.as_deref(), Some(&["one".to_string(), "two".to_string()][..]));
        assert_eq!(
            c.new_lines.as_deref(),
            Some(&["one".to_string(), "TWO".to_string(), "three".to_string()][..])
        );
    }

    #[tokio::test]
    async fn file_contents_staged_reads_index_not_worktree() {
        let td = temp_repo().await;
        let d = td.path();
        tokio::fs::write(d.join("a.txt"), "one\nTWO\n").await.unwrap();
        run(d, &["add", "a.txt"]).await;
        // Later unstaged edit must NOT appear on the staged new side.
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();
        let c = file_contents_for(d, DiffSource::Staged, None, None, "a.txt", None)
            .await
            .unwrap();
        assert_eq!(
            c.new_lines.as_deref(),
            Some(&["one".to_string(), "TWO".to_string()][..])
        );
    }

    #[tokio::test]
    async fn file_contents_added_file_has_no_old_side() {
        let td = temp_repo().await;
        let d = td.path();
        tokio::fs::write(d.join("new.txt"), "hello\n").await.unwrap();
        let c = file_contents_for(d, DiffSource::Uncommitted, None, None, "new.txt", None)
            .await
            .unwrap();
        assert!(c.old_lines.is_none(), "untracked file isn't in HEAD");
        assert_eq!(c.new_lines.as_deref(), Some(&["hello".to_string()][..]));
    }

    #[tokio::test]
    async fn file_contents_rejects_traversal_and_absolute_paths() {
        let td = temp_repo().await;
        let d = td.path();
        for bad in ["../etc/passwd", "/etc/passwd", "a/../../b", ""] {
            let err = file_contents_for(d, DiffSource::Uncommitted, None, None, bad, None).await;
            assert!(err.is_err(), "expected rejection for {bad:?}");
        }
        // A hostile old_path is rejected the same way.
        let err =
            file_contents_for(d, DiffSource::Uncommitted, None, None, "a.txt", Some("../x")).await;
        assert!(err.is_err());
    }

    #[test]
    fn parse_branches_classifies_on_full_refname() {
        let out = "refs/heads/main\tmain\n\
                   refs/heads/feature/foo\tfeature/foo\n\
                   refs/remotes/origin/HEAD\torigin/HEAD\n\
                   refs/remotes/origin/main\torigin/main\n";
        let b = parse_branches(out, Some("main".into()));
        // `feature/foo` is LOCAL despite the slash — full-refname classification.
        assert_eq!(b.local, vec!["main", "feature/foo"]);
        // origin/HEAD is a pointer, not a base.
        assert_eq!(b.remote, vec!["origin/main"]);
        assert_eq!(b.head.as_deref(), Some("main"));
    }
}

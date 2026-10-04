// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The chat room's WORKSPACE BRIEF: what Redline already knows about the
//! user's work, handed to the chat on its first turn so it does not have to
//! curl for it.
//!
//! Deterministic and bounded by construction. It is built only from local
//! readers (the session store, the projects' git state, the work graph, the
//! context journal, the ledger and the active mission), never from a model
//! call, and it carries no relative times. The same workspace therefore
//! renders the same bytes, which is what lets a follow-up turn send only a
//! hash-keyed DELTA instead of the whole brief again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::Database;
use crate::state::{SessionStatus, SessionSummary};

/// The whole brief, rendered.
pub const WORKSPACE_BRIEF_MAX_BYTES: usize = 6_000;
/// A follow-up's delta: changes only, so it is small or absent.
pub const BRIEF_DELTA_MAX_BYTES: usize = 2_000;

const LINE_CHARS: usize = 160;
const MAX_PLANS: usize = 8;
const MAX_REPOS: usize = 5;
const MAX_READY: usize = 5;
const MAX_PAGES: usize = 15;
const MAX_DECISIONS: usize = 5;
/// One git probe's ceiling. The brief is on the turn's critical path, so a
/// slow repo costs this much at most and is reported without its git state.
const GIT_TIMEOUT: Duration = Duration::from_millis(1_500);

const PREAMBLE: &str = "WORKSPACE BRIEF: read by Redline from local state at this turn's start (no search, no model). Use it before curling, and cite plans, repos and pages by name.";

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefPlan {
    pub session_id: String,
    pub title: String,
    pub project: String,
    pub status: String,
    pub day: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefRepo {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub dirty: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefPage {
    pub title: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefMission {
    pub title: String,
    pub goal: String,
}

/// Everything the brief says, in the order it says it. Also the payload the
/// room's Context chip lists, so the chip shows exactly what was injected.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefInputs {
    pub plans: Vec<BriefPlan>,
    pub repos: Vec<BriefRepo>,
    /// `None` when the count could not be read: unknown, not zero.
    pub ready_count: Option<i64>,
    pub ready: Vec<String>,
    pub pages: Vec<BriefPage>,
    pub decisions: Vec<String>,
    pub mission: Option<BriefMission>,
}

/// A plan's status as the brief says it. "approved · not built" is the state
/// Track R made visible: approved with no `run_state`, so nothing is building it.
pub fn plan_status(status: SessionStatus, run_state: Option<&str>, awaiting_review: bool) -> String {
    match status {
        SessionStatus::InReview if awaiting_review => "in review · waiting on you".into(),
        SessionStatus::InReview => "in review".into(),
        SessionStatus::Aborted => "aborted".into(),
        SessionStatus::Approved => match run_state.map(str::trim).filter(|s| !s.is_empty()) {
            None => "approved · not built".into(),
            Some("building") => "building".into(),
            Some(other) => format!("approved · {other}"),
        },
    }
}

/// `YYYY-MM-DD` (UTC) for a millisecond timestamp. A day, never "3 minutes
/// ago": a relative time would change the bytes on every turn and defeat the
/// delta.
pub fn day(ms: i64) -> String {
    // Howard Hinnant's civil-from-days.
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn clip(text: &str, chars: usize) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= chars {
        return one;
    }
    let mut cut: String = one.chars().take(chars.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// The brief's sections as `(header, lines)`, in priority order: when the
/// budget runs out it is the later sections that lose lines.
fn sections(inputs: &BriefInputs) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    if !inputs.plans.is_empty() {
        out.push((
            "Plan sessions (newest first):".to_string(),
            inputs
                .plans
                .iter()
                // Status first: a long title must never clip it away.
                .map(|p| format!("- {} · \"{}\" · {} · {}", p.status, clip(&p.title, 80), p.project, p.day))
                .collect(),
        ));
    }
    if !inputs.repos.is_empty() {
        out.push((
            "Repos (recently worked in):".to_string(),
            inputs
                .repos
                .iter()
                .map(|r| {
                    let branch = r.branch.as_deref().unwrap_or("no branch read");
                    let dirty = match r.dirty {
                        Some(0) => "clean".to_string(),
                        Some(1) => "1 changed file".to_string(),
                        Some(n) => format!("{n} changed files"),
                        None => "status unknown".to_string(),
                    };
                    format!("- {} · {} · {} · {}", r.name, branch, dirty, r.path)
                })
                .collect(),
        ));
    }
    match inputs.ready_count {
        Some(n) if n > 0 => out.push((
            format!("Ready work items ({n} ready; top {}):", inputs.ready.len()),
            inputs.ready.iter().map(|t| format!("- {t}")).collect(),
        )),
        Some(_) => out.push(("Ready work items: none ready.".to_string(), Vec::new())),
        None => {}
    }
    if let Some(m) = &inputs.mission {
        out.push((
            "Active research mission:".to_string(),
            vec![format!("- {} — {}", m.title, m.goal)],
        ));
    }
    if !inputs.decisions.is_empty() {
        out.push((
            "Recent decisions (newest first):".to_string(),
            inputs.decisions.iter().map(|d| format!("- {d}")).collect(),
        ));
    }
    if !inputs.pages.is_empty() {
        out.push((
            "Recently browsed (newest first):".to_string(),
            inputs
                .pages
                .iter()
                .map(|p| format!("- {} — {}", p.title, p.url))
                .collect(),
        ));
    }
    out
}

/// Render the brief. Every line is clipped and the whole is held to
/// `WORKSPACE_BRIEF_MAX_BYTES`, trimming the lowest-priority lines first and
/// saying so. Empty when there is nothing to say.
pub fn render(inputs: &BriefInputs) -> String {
    let sections = sections(inputs);
    if sections.is_empty() {
        return String::new();
    }
    let mut out = String::from(PREAMBLE);
    out.push('\n');
    const TRIMMED: &str = "- … (trimmed to fit)\n";
    for (header, lines) in sections {
        let header = format!("{}\n", clip(&header, LINE_CHARS));
        if out.len() + header.len() + TRIMMED.len() > WORKSPACE_BRIEF_MAX_BYTES {
            break;
        }
        out.push_str(&header);
        let mut dropped = false;
        for line in lines {
            let line = format!("{}\n", clip(&line, LINE_CHARS));
            if out.len() + line.len() + TRIMMED.len() > WORKSPACE_BRIEF_MAX_BYTES {
                dropped = true;
                break;
            }
            out.push_str(&line);
        }
        if dropped {
            out.push_str(TRIMMED);
            break;
        }
    }
    out
}

pub fn brief_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// What changed between the brief the conversation last saw and this one:
/// every new line, under its section header. `None` when nothing changed, so
/// an unchanged workspace costs a follow-up nothing.
pub fn delta(previous: &str, current: &str) -> Option<String> {
    if brief_hash(previous) == brief_hash(current) {
        return None;
    }
    let old: HashSet<&str> = previous.lines().collect();
    let mut out = String::from(
        "WORKSPACE CHANGES since the last brief (only what changed; the rest still stands):\n",
    );
    let base = out.len();
    let mut header: Option<&str> = None;
    let mut header_written = false;
    for line in current.lines().skip(1) {
        if !line.starts_with("- ") {
            header = Some(line);
            header_written = false;
            // A changed header (a ready count moved) is news on its own.
            if !old.contains(line) {
                out.push_str(line);
                out.push('\n');
                header_written = true;
            }
            continue;
        }
        if old.contains(line) {
            continue;
        }
        if !header_written {
            if let Some(h) = header {
                out.push_str(h);
                out.push('\n');
            }
            header_written = true;
        }
        out.push_str(line);
        out.push('\n');
    }
    if out.len() == base {
        out.push_str("- Some items dropped off the recent lists.\n");
    }
    if out.len() > BRIEF_DELTA_MAX_BYTES {
        let mut cut = BRIEF_DELTA_MAX_BYTES - 24;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        let at = out[..cut].rfind('\n').map(|i| i + 1).unwrap_or(cut);
        out.truncate(at);
        out.push_str("- … (trimmed to fit)\n");
    }
    Some(out)
}

/// Branch and changed-file count for one repo, each bounded by `GIT_TIMEOUT`.
async fn probe_repo(path: PathBuf) -> (Option<String>, Option<usize>) {
    let branch = tokio::time::timeout(
        GIT_TIMEOUT,
        crate::worktree::git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .filter(|b| !b.is_empty());
    if branch.is_none() {
        return (None, None);
    }
    let dirty = tokio::time::timeout(
        GIT_TIMEOUT,
        crate::worktree::git(&path, &["status", "--porcelain"]),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count());
    (branch, dirty)
}

/// Gather the brief from local readers. Never fails: an unreadable source is
/// left out (or, for the ready count, reported as unknown).
pub async fn gather(
    sessions: Vec<SessionSummary>,
    db: &Database,
    mission: Option<(String, String)>,
) -> BriefInputs {
    let mut sessions = sessions;
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.session_id.cmp(&b.session_id)));
    let title_of = |s: &SessionSummary| {
        s.plan_title
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(s.project_name.as_str())
            .to_string()
    };

    let plans: Vec<BriefPlan> = sessions
        .iter()
        .take(MAX_PLANS)
        .map(|s| BriefPlan {
            session_id: s.session_id.to_string(),
            title: clip(&title_of(s), 80),
            project: s.project_name.clone(),
            status: plan_status(s.status, s.run_state.as_deref(), s.awaiting_review),
            day: day(s.updated_at),
        })
        .collect();

    // Repos: where the recent plans live first, then the known-project list.
    let mut seen = HashSet::new();
    let candidates: Vec<String> = sessions
        .iter()
        .map(|s| s.project_path.clone())
        .chain(db.list_project_paths().unwrap_or_default())
        .filter(|p| !p.trim().is_empty() && seen.insert(p.clone()) && Path::new(p).is_dir())
        .take(MAX_REPOS)
        .collect();
    let probes: Vec<_> = candidates
        .iter()
        .map(|p| tokio::spawn(probe_repo(PathBuf::from(p))))
        .collect();
    let mut repos = Vec::with_capacity(candidates.len());
    for (path, probe) in candidates.into_iter().zip(probes) {
        let (branch, dirty) = probe.await.unwrap_or((None, None));
        let name = Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        repos.push(BriefRepo { name, path, branch, dirty });
    }

    let now = crate::ledger::now_millis();
    let ready_count = db.count_ready_work_items(None, now).ok();
    let ready = if ready_count.unwrap_or(0) > 0 {
        db.list_ready_work_items(None, now, MAX_READY as i64)
            .unwrap_or_default()
            .into_iter()
            .map(|w| {
                let project = w
                    .project_path
                    .as_deref()
                    .and_then(|p| Path::new(p).file_name())
                    .map(|n| format!(" ({})", n.to_string_lossy()))
                    .unwrap_or_default();
                format!("{}{project}", clip(&w.title, 100))
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut urls = HashSet::new();
    let pages: Vec<BriefPage> = db
        .list_recent_journal_kind("nav", 60)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| {
            let url = row.detail.filter(|u| u.starts_with("http://") || u.starts_with("https://"))?;
            if !urls.insert(url.clone()) {
                return None;
            }
            let title = row.label.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| url.clone());
            Some(BriefPage { title: clip(&title, 70), url: clip(&url, 80) })
        })
        .take(MAX_PAGES)
        .collect();

    let plan_title = |sid: &str| sessions.iter().find(|s| s.session_id.as_str() == sid).map(&title_of);
    let decisions: Vec<String> = db
        .recent_decisions(MAX_DECISIONS as i64)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, kind, session, comment)| {
            let mut line = kind.replace('_', " ");
            if let Some(body) = comment.filter(|b| !b.trim().is_empty()) {
                line.push_str(&format!(": \"{}\"", clip(&body, 90)));
            }
            if let Some(title) = session.as_deref().and_then(plan_title) {
                line.push_str(&format!(" · on \"{}\"", clip(&title, 60)));
            }
            line
        })
        .collect();

    BriefInputs {
        plans,
        repos,
        ready_count,
        ready,
        pages,
        decisions,
        mission: mission.map(|(title, goal)| BriefMission {
            title: clip(&title, 60),
            goal: clip(&goal, 120),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big_inputs(n: usize) -> BriefInputs {
        BriefInputs {
            plans: (0..n)
                .map(|i| BriefPlan {
                    session_id: format!("s{i}"),
                    title: format!("Plan number {i} {}", "with a very long title ".repeat(10)),
                    project: "redline".into(),
                    status: "approved · not built".into(),
                    day: "2026-10-02".into(),
                })
                .collect(),
            repos: (0..n)
                .map(|i| BriefRepo { name: format!("repo{i}"), path: format!("/Users/me/repo{i}"), branch: Some("main".into()), dirty: Some(i) })
                .collect(),
            ready_count: Some(n as i64),
            ready: (0..n).map(|i| format!("Work item {i}")).collect(),
            pages: (0..n)
                .map(|i| BriefPage { title: format!("Page {i}"), url: format!("https://example.com/{i}") })
                .collect(),
            decisions: (0..n).map(|i| format!("approval · on \"Plan {i}\"")).collect(),
            mission: Some(BriefMission { title: "Mission".into(), goal: "Find the thing".into() }),
        }
    }

    #[test]
    fn the_brief_is_bounded_and_says_when_it_trimmed() {
        let text = render(&big_inputs(500));
        assert!(text.len() <= WORKSPACE_BRIEF_MAX_BYTES, "{} bytes", text.len());
        assert!(text.contains("(trimmed to fit)"));
        assert!(text.lines().all(|l| l.chars().count() <= LINE_CHARS.max(PREAMBLE.chars().count())));
        // Priority order: plans survive a trim, the browse list goes first.
        assert!(text.contains("Plan sessions"));
    }

    #[test]
    fn the_brief_is_deterministic() {
        let inputs = big_inputs(6);
        assert_eq!(render(&inputs), render(&inputs.clone()));
        assert_eq!(brief_hash(&render(&inputs)), brief_hash(&render(&inputs)));
        assert!(render(&BriefInputs::default()).is_empty());
    }

    #[test]
    fn plan_status_names_approved_but_unbuilt_and_building() {
        assert_eq!(plan_status(SessionStatus::Approved, None, false), "approved · not built");
        assert_eq!(plan_status(SessionStatus::Approved, Some("building"), false), "building");
        assert_eq!(plan_status(SessionStatus::Approved, Some("done"), false), "approved · done");
        assert_eq!(plan_status(SessionStatus::InReview, None, true), "in review · waiting on you");
        assert_eq!(plan_status(SessionStatus::Aborted, None, false), "aborted");
    }

    #[test]
    fn day_is_a_utc_calendar_date() {
        assert_eq!(day(0), "1970-01-01");
        // 2026-10-02T12:00:00Z
        assert_eq!(day(1_790_942_400_000), "2026-10-02");
    }

    #[test]
    fn the_delta_carries_only_what_changed() {
        let before = big_inputs(3);
        let mut after = before.clone();
        assert!(delta(&render(&before), &render(&after)).is_none(), "an unchanged workspace sends nothing");
        after.plans[1].status = "building".into();
        after.ready_count = Some(4);
        let d = delta(&render(&before), &render(&after)).unwrap();
        assert!(d.contains("building"), "{d}");
        assert!(d.contains("Plan sessions"), "the changed line keeps its header: {d}");
        assert!(d.contains("4 ready"), "a moved count is news: {d}");
        assert!(!d.contains("Plan number 0"), "unchanged lines stay out: {d}");
        assert!(!d.contains("https://example.com/0"), "{d}");
        assert!(d.len() <= BRIEF_DELTA_MAX_BYTES);
    }

    #[tokio::test]
    async fn gather_reads_pages_and_decisions_from_local_state() {
        let db = Database::open_in_memory().unwrap();
        for (title, url) in [("Old", "https://a.test/"), ("Docs", "https://b.test/"), ("Again", "https://a.test/"), ("Local", "file:///x.pdf")] {
            db.append_journal("nav", Some("browser"), None, Some(title), Some(url)).unwrap();
        }
        db.append_journal("surface_switch", Some("plan"), None, Some("Plan"), Some("https://c.test/")).unwrap();
        let inputs = gather(Vec::new(), &db, Some(("Mission".into(), "Find it".into()))).await;
        // Newest first, one row per URL, http(s) only, nav rows only.
        let urls: Vec<&str> = inputs.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(urls, ["https://a.test/", "https://b.test/"]);
        assert_eq!(inputs.pages[0].title, "Again");
        assert!(inputs.decisions.is_empty());
        assert_eq!(inputs.ready_count, Some(0));
        assert_eq!(inputs.mission.as_ref().map(|m| m.goal.as_str()), Some("Find it"));
        let text = render(&inputs);
        assert!(text.contains("Ready work items: none ready."));
        assert!(text.contains("Again — https://a.test/"));
    }

    #[test]
    fn a_large_delta_is_bounded() {
        let d = delta("", &render(&big_inputs(500))).unwrap();
        assert!(d.len() <= BRIEF_DELTA_MAX_BYTES, "{} bytes", d.len());
    }
}

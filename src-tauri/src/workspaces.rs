// SPDX-License-Identifier: Apache-2.0
//! Separate Git folders; never switch the user's checkout. The registry is
//! also the parent link used by the known-project allowlist.
use crate::{
    db::Database,
    guided::{self, ActionResult, GuidedOp},
    review::{self, ReviewState},
};
use rusqlite::OptionalExtension;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub title: String,
    pub base_sha: String,
    pub created_at: i64,
    pub state: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreated {
    pub workspace: Workspace,
    pub action: ActionResult,
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: r.get(0)?,
        repo: r.get(1)?,
        path: r.get(2)?,
        branch: r.get(3)?,
        title: r.get(4)?,
        base_sha: r.get(5)?,
        created_at: r.get(6)?,
        state: r.get(7)?,
    })
}
fn canonical(dir: &Path) -> Result<String, String> {
    std::fs::canonicalize(dir)
        .map(|p| p.to_string_lossy().into())
        .map_err(|e| e.to_string())
}
fn active_at(db: &Database, path: &str) -> Result<Option<Workspace>, String> {
    db.lock_conn().query_row("SELECT id,repo,path,branch,title,base_sha,created_at,state FROM git_workspaces WHERE path=?1 AND state='active'",[path],row).optional().map_err(|e|e.to_string())
}
fn by_id(db: &Database, id: &str) -> Result<Workspace, String> {
    db.lock_conn().query_row("SELECT id,repo,path,branch,title,base_sha,created_at,state FROM git_workspaces WHERE id=?1 AND state='active'",[id],row).map_err(|_|"This workspace is no longer available.".into())
}
async fn create_at(
    db: &Database,
    dir: &Path,
    title: &str,
    from: Option<&str>,
    root: &Path,
) -> Result<WorkspaceCreated, String> {
    if title.trim().is_empty() {
        return Err("Give this workspace a name first.".into());
    }
    let canonical = canonical(dir)?;
    let parent = active_at(db, &canonical)?
        .map(|w| w.repo)
        .unwrap_or(canonical);
    let parent_dir = Path::new(&parent);
    let sha = guided::revision(dir, from.unwrap_or("HEAD")).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let slug = title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    let slug = format!(
        "{}-{}",
        if slug.is_empty() {
            "idea"
        } else {
            &slug[..slug.len().min(48)]
        },
        &id[..8]
    );
    let repo_id = format!("{:x}", Sha256::digest(parent.as_bytes()));
    let path = root.join(&repo_id[..16]).join(&slug);
    std::fs::create_dir_all(path.parent().ok_or("workspace folder unavailable")?)
        .map_err(|e| e.to_string())?;
    let branch = format!("redline/ws/{slug}");
    let mut action = ActionResult::default();
    let out = guided::run(
        parent_dir,
        GuidedOp::WorktreeAdd {
            path: path.to_string_lossy().into(),
            branch: branch.clone(),
            from: sha.clone(),
        },
        None,
        &mut action,
    )
    .await?;
    if out.code != 0 {
        return Err(crate::git_human::explain(&out.stderr).message);
    }
    let workspace = Workspace {
        id,
        repo: parent.clone(),
        path: canonical_path(&path),
        branch,
        title: title.trim().chars().take(160).collect(),
        base_sha: sha,
        created_at: crate::state::now_millis(),
        state: "active".into(),
    };
    if let Err(e)=db.lock_conn().execute("INSERT INTO git_workspaces (id,repo,path,branch,title,base_sha,created_at,state) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",rusqlite::params![workspace.id,workspace.repo,workspace.path,workspace.branch,workspace.title,workspace.base_sha,workspace.created_at,workspace.state]){return Err(format!("The workspace folder was created at {} but could not be remembered: {e}",workspace.path));}
    action.repo = Some(workspace.path.clone());
    action.message = "Your idea has its own folder. Your original project is unchanged.".into();
    Ok(WorkspaceCreated { workspace, action })
}
fn canonical_path(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.into())
        .to_string_lossy()
        .into()
}
#[tauri::command]
pub async fn workspace_create(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    title: String,
    from: Option<String>,
) -> Result<WorkspaceCreated, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    let _lock = guided::repo_lock(&dir).await;
    let root = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Your home folder is unavailable.")?
        .join(".redline/workspaces");
    create_at(&state.db, &dir, &title, from.as_deref(), &root).await
}
async fn list_for(db: &Database, dir: &Path) -> Result<Vec<Workspace>, String> {
    let path = canonical(dir)?;
    let parent = active_at(db, &path)?.map(|w| w.repo).unwrap_or(path);
    let mut action = ActionResult::default();
    let pruned = guided::run(
        Path::new(&parent),
        GuidedOp::WorktreePrune,
        None,
        &mut action,
    )
    .await?;
    if pruned.code != 0 {
        return Err(crate::git_human::explain(&pruned.stderr).message);
    }
    let rows = {
        let conn = db.lock_conn();
        let mut stmt=conn.prepare("SELECT id,repo,path,branch,title,base_sha,created_at,state FROM git_workspaces WHERE repo=?1 AND state='active' ORDER BY created_at DESC").map_err(|e|e.to_string())?;
        let result = stmt
            .query_map([&parent], row)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        result
    };
    let mut active = Vec::new();
    for w in rows {
        if Path::new(&w.path).is_dir() {
            active.push(w);
        } else {
            db.lock_conn()
                .execute(
                    "UPDATE git_workspaces SET state='missing' WHERE id=?1",
                    [w.id],
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(active)
}
#[tauri::command]
pub async fn workspace_list(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<Vec<Workspace>, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    let _lock = guided::repo_lock(&dir).await;
    list_for(&state.db, &dir).await
}
#[tauri::command]
pub async fn workspace_status(
    state: tauri::State<'_, ReviewState>,
    id: String,
) -> Result<crate::push::GitStatus, String> {
    let w = by_id(&state.db, &id)?;
    let dir = review::checked_repo_dir(&state.db, &w.path).await?;
    Ok(crate::push::status_for(&dir).await)
}
async fn archive_for(db: &Database, w: &Workspace) -> Result<ActionResult, String> {
    let dir = Path::new(&w.path);
    guided::require_clean(dir).await?;
    let head = guided::revision(dir, "HEAD").await?;
    let main_contains = guided::read(
        Path::new(&w.repo),
        &["merge-base", "--is-ancestor", &head, "HEAD"],
    )
    .await
    .is_ok();
    let shared = guided::read(dir, &["rev-list", "--count", "@{upstream}..HEAD"])
        .await
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        == Some(0);
    let unchanged = head == w.base_sha;
    if !shared && !main_contains && !unchanged {
        return Err("Share your saved versions or bring them into the main version before archiving this workspace.".into());
    }
    let mut action = ActionResult::default();
    let out = guided::run(
        Path::new(&w.repo),
        GuidedOp::WorktreeRemove {
            path: w.path.clone(),
        },
        None,
        &mut action,
    )
    .await?;
    if out.code != 0 {
        return Err(crate::git_human::explain(&out.stderr).message);
    }
    db.lock_conn()
        .execute(
            "UPDATE git_workspaces SET state='archived' WHERE id=?1",
            [&w.id],
        )
        .map_err(|e| e.to_string())?;
    action.message = "Workspace archived. Its saved versions remain available.".into();
    Ok(action)
}
#[tauri::command]
pub async fn workspace_archive(
    state: tauri::State<'_, ReviewState>,
    id: String,
) -> Result<ActionResult, String> {
    let w = by_id(&state.db, &id)?;
    let dir = review::checked_repo_dir(&state.db, &w.path).await?;
    let _lock = guided::repo_lock(&dir).await;
    archive_for(&state.db, &w).await
}
#[tauri::command]
pub async fn workspace_bring_in(
    state: tauri::State<'_, ReviewState>,
    id: String,
) -> Result<ActionResult, String> {
    let w = by_id(&state.db, &id)?;
    let dir = review::checked_repo_dir(&state.db, &w.repo).await?;
    let _lock = guided::repo_lock(&dir).await;
    bring_in_for(&dir, &w).await
}
async fn bring_in_for(dir: &Path, workspace: &Workspace) -> Result<ActionResult, String> {
    guided::require_clean(dir).await?;
    let status = crate::push::status_for(dir).await;
    let is_main = match status.default_branch.as_deref() {
        Some(expected) => status.branch.as_deref() == Some(expected),
        None => matches!(status.branch.as_deref(), Some("main" | "master")),
    };
    if !is_main {
        return Err("Your original project is on another version. Open its main version in the code view before bringing this workspace in.".into());
    }
    let mut action = ActionResult::default();
    guided::merge(
        dir,
        guided::revision(dir, &workspace.branch).await?,
        false,
        true,
        &mut action,
    )
    .await?;
    Ok(action)
}
#[tauri::command]
pub async fn guided_save(
    state: tauri::State<'_, ReviewState>,
    review_id: String,
    message: String,
    fingerprint: String,
) -> Result<ActionResult, String> {
    let session = state
        .db
        .get_code_review(&review_id)
        .ok_or("Open a review before saving.")?;
    if session.source != "uncommitted" {
        return Err("Review your unsaved changes before saving a version.".into());
    }
    let dir = review::checked_repo_dir(&state.db, &session.repo_path).await?;
    let _lock = guided::repo_lock(&dir).await;
    if crate::push::in_progress_op(&dir).await.is_some() {
        return Err("Cancel or finish the unfinished operation first.".into());
    }
    let branch = guided::read(&dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
    if branch.is_err() {
        return Err("Open a workspace before saving this version.".into());
    }
    if message.trim().is_empty() {
        return Err("Describe this version before saving it.".into());
    }
    if review::fingerprint_for(&dir, review::DiffSource::Uncommitted, None, None).await?
        != fingerprint
    {
        return Err(
            "The files changed while you were reviewing. Refresh and review them before saving."
                .into(),
        );
    }
    let (_, files) = review::resolve_for_route(
        &state.db,
        &session.repo_path,
        review::DiffSource::Uncommitted,
        None,
        None,
    )
    .await?;
    if files.is_empty() {
        return Err(crate::git_human::explain("nothing to save").message);
    }
    let mut paths = Vec::new();
    for file in &files {
        paths.push(review::safe_rel_path(review::display_path(file))?.into());
        if file.status == review::FileStatus::Renamed {
            paths.push(review::safe_rel_path(&file.old_path)?.into());
        }
    }
    let mut result = ActionResult::default();
    let stage = guided::run(&dir, GuidedOp::Stage { paths }, None, &mut result).await?;
    if stage.code != 0 {
        return Err(crate::git_human::explain(&stage.stderr).message);
    }
    let saved = guided::run(
        &dir,
        GuidedOp::Commit,
        Some(message.as_bytes()),
        &mut result,
    )
    .await?;
    if saved.code != 0 {
        return Err(crate::git_human::explain(&saved.stderr).message);
    }
    result.message = "A new version is saved on this computer.".into();
    Ok(result)
}
#[tauri::command]
pub async fn guided_share(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    ask_review: bool,
    title: String,
    body: String,
) -> Result<ActionResult, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    let _lock = guided::repo_lock(&dir).await;
    guided::require_clean(&dir).await?;
    let workspace = active_at(&state.db, &canonical(&dir)?)?
        .ok_or("Create a workspace to share this work with your team.")?;
    let status = crate::push::status_for(&dir).await;
    if status.branch.as_deref() != Some(&workspace.branch)
        || !workspace.branch.starts_with("redline/ws/")
    {
        return Err("This folder no longer matches the workspace. Open its original workspace before sharing.".into());
    }
    if status.default_branch.as_deref() == Some(&workspace.branch) {
        return Err(
            "The team protects this version. Create a new workspace before sharing.".into(),
        );
    }
    let remote = status
        .default_remote
        .ok_or("This project has no connected team copy yet.")?;
    let mut action = ActionResult::default();
    let out = guided::run(
        &dir,
        GuidedOp::Share {
            remote,
            branch: workspace.branch.clone(),
        },
        None,
        &mut action,
    )
    .await?;
    if out.code != 0 {
        return Err(crate::git_human::explain(&out.stderr).message);
    }
    action.message = "Your workspace is shared with your team.".into();
    if ask_review {
        if let Some(gh) = crate::push::resolve_gh_bin() {
            let base = status.default_branch.unwrap_or_else(|| "main".into());
            let args: Vec<String> = [
                "pr",
                "create",
                "--head",
                &workspace.branch,
                "--base",
                &base,
                "--title",
                &title,
                "--body-file",
                "-",
            ]
            .into_iter()
            .map(str::to_string)
            .collect();
            let result = crate::push::run_bin(
                &gh,
                &dir,
                &args,
                Some(body.as_bytes()),
                Duration::from_secs(120),
            )
            .await;
            action.commands.push(guided::ActionCommand{command:format!("gh {}",args.iter().map(|s|format!("'{}'",s.replace('\'',"'\\''"))).collect::<Vec<_>>().join(" ")),meaning:"Asked your team to review this workspace; the description was supplied as input.".into(),ok:result.as_ref().is_ok_and(|r|r.code==0)});
            match result {Ok(r) if r.code==0=>{action.message=format!("Workspace shared. Review requested: {}",crate::push::parse_pr_url(&r.stdout).unwrap_or_default());},_=>action.message="Your workspace was shared, but the review request could not be created. Check your GitHub connection and try asking for review again.".into()}
        } else {
            action.message="Your workspace is shared. Install and connect GitHub's command line app to ask for review here.".into();
        }
    }
    Ok(action)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::tests::{fixture, git};
    #[tokio::test]
    async fn bringing_in_refuses_a_different_checkout_branch_without_moving_any_refs() {
        let (root, local, _) = fixture();
        let db = Database::open_in_memory().unwrap();
        let workspace = create_at(&db, &local, "Idea", None, &root.path().join("workspaces"))
            .await
            .unwrap()
            .workspace;
        std::fs::write(Path::new(&workspace.path).join("idea"), "idea").unwrap();
        git(Path::new(&workspace.path), &["add", "."]);
        git(Path::new(&workspace.path), &["commit", "-m", "Idea"]);
        git(&local, &["switch", "-c", "another-idea"]);
        let refs = git(&local, &["show-ref"]);
        assert!(bring_in_for(&local, &workspace)
            .await
            .unwrap_err()
            .contains("main version"));
        assert_eq!(git(&local, &["show-ref"]), refs);
        assert!(!local.join("idea").exists());
        git(&local, &["switch", "main"]);
        bring_in_for(&local, &workspace).await.unwrap();
        assert_eq!(std::fs::read_to_string(local.join("idea")).unwrap(), "idea");
        assert!(git(&local, &["status", "--porcelain=v1"]).is_empty());
    }
    #[tokio::test]
    async fn workspaces_create_register_refuse_archive_and_prune() {
        let (root, local, _) = fixture();
        let db = Database::open_in_memory().unwrap();
        let head = git(&local, &["rev-parse", "HEAD"]);
        let result = create_at(
            &db,
            &local,
            "Pricing idea",
            None,
            &root.path().join("workspaces"),
        )
        .await
        .unwrap();
        let w = result.workspace;
        assert_eq!(git(&local, &["rev-parse", "HEAD"]), head);
        assert!(crate::code::is_known_project(&db, &w.path));
        assert_eq!(list_for(&db, &local).await.unwrap().len(), 1);
        std::fs::write(Path::new(&w.path).join("idea"), "idea").unwrap();
        assert!(archive_for(&db, &w).await.unwrap_err().contains("Save"));
        git(Path::new(&w.path), &["add", "."]);
        git(Path::new(&w.path), &["commit", "-m", "Idea"]);
        assert!(archive_for(&db, &w).await.unwrap_err().contains("Share"));
        git(&local, &["merge", "--no-ff", "--no-edit", &w.branch]);
        assert!(archive_for(&db, &w).await.is_ok());
        assert!(list_for(&db, &local).await.unwrap().is_empty());
        assert!(git(&local, &["branch", "--list", &w.branch]).contains(&w.branch));
        let w = create_at(
            &db,
            &local,
            "Old idea",
            None,
            &root.path().join("workspaces"),
        )
        .await
        .unwrap()
        .workspace;
        std::fs::remove_dir_all(&w.path).unwrap();
        assert!(list_for(&db, &local).await.unwrap().is_empty());
    }
}

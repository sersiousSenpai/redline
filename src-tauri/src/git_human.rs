// SPDX-License-Identifier: Apache-2.0
//! One vocabulary for actionable, non-technical Git errors. Raw diagnostics
//! belong in developer logs, never in the Guided story.
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanError {
    pub message: String,
    pub next_action: &'static str,
}
pub(crate) fn explain(error: &str) -> HumanError {
    let s = error.to_lowercase();
    let (message, next_action) = if s.contains("protected")
        || s.contains("gh006")
        || s.contains("gh013")
    {
        (
            "Your team protects the main version. Share a workspace and ask for review.",
            "workspace",
        )
    } else if s.contains("non-fast-forward")
        || s.contains("fetch first")
        || s.contains("[rejected]")
    {
        (
            "Your team shared something first. Get updates, then share again.",
            "updates",
        )
    } else if [
        "authentication",
        "could not read username",
        "permission denied",
        "403",
        "not logged",
    ]
    .iter()
    .any(|p| s.contains(p))
    {
        ("Redline could not sign in to your team copy. Connect your GitHub account and try again.", "connect")
    } else if [
        "resolve host",
        "network",
        "connection",
        "timed out",
        "unable to access",
    ]
    .iter()
    .any(|p| s.contains(p))
    {
        (
            "Redline could not reach your team copy. Check your connection, then try again.",
            "retry",
        )
    } else if s.contains("no remote")
        || s.contains("not a configured remote")
        || s.contains("no tracking")
    {
        ("This project has no connected team copy yet. You can still save versions on this computer.", "save")
    } else if s.contains("nothing to commit") || s.contains("nothing to save") {
        (
            "Everything is already saved. There are no new changes to save.",
            "timeline",
        )
    } else if s.contains("already checked out") || s.contains("already used by worktree") {
        ("That workspace is already open in another folder. Open the existing workspace instead.", "workspace")
    } else if s.contains("conflict") {
        ("Two people edited the same spot. Your work has been kept; ask for help combining the changes.", "resolve")
    } else {
        ("Redline could not finish this action. Your saved versions are still available; check the project and try again.", "retry")
    };
    HumanError {
        message: message.into(),
        next_action,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn errors_offer_actions_without_git_jargon() {
        for raw in [
            "non-fast-forward",
            "authentication failed",
            "network error",
            "protected branch",
            "no remote",
            "nothing to commit",
            "already checked out",
            "conflict",
            "HEAD refs/ -- upstream",
        ] {
            let error = explain(raw);
            assert!(!error.next_action.is_empty());
            for jargon in ["HEAD", "refs/", "--", "upstream"] {
                assert!(!error.message.contains(jargon));
            }
        }
    }
}

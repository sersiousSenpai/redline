// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::fs;
use std::path::PathBuf;

use serde::Serialize;

/// A Redline skill embedded at compile time. The source of truth is
/// `skills/<name>/SKILL.md` at the repo root (the in-repo `.agents/skills/<name>`
/// path is a symlink to it; there is deliberately no `.claude/skills` copy — the
/// app installs to `~/.claude`, and a project-level copy would register the skill
/// twice in Claude Code sessions inside this repo). `install` writes each
/// skill's exact content to `~/.claude/skills/<name>/SKILL.md` so every Claude
/// Code session that reaches Redline is fluent in the contract.
struct EmbeddedSkill {
    /// Directory name under `skills/` and `~/.claude/skills/`.
    name: &'static str,
    /// Bump in lockstep with the `version:` field in the SKILL.md frontmatter.
    /// `version_constants_match_frontmatter` asserts the two never drift.
    version: u32,
    /// Compile-time content from `skills/<name>/SKILL.md`.
    content: &'static str,
}

/// The skills Redline installs. `include_str!` resolves relative to this source
/// file (`src-tauri/src/`), so `../../` is the repo root. A missing canonical
/// file fails the build — the intended fail-fast.
///
/// - `redline`: the plan-revision protocol contract.
/// - `sidecar`: how to structure read-only discussion-thread replies.
/// - `conversation`: the collaborator persona + cadence for a discussion thread
///   the reviewer has toggled into conversation mode.
/// - `browse`: how the embedded-browser page-discussion agent picks tools
///   (browser bridge vs WebSearch vs WebFetch), drives the tab, and formats.
/// - `mission`: how the browser mission orchestrator holds a goal, gathers
///   across tabs + the user's pins, and synthesizes a Drafter-ready brief.
/// - `linked`: how a linked discussion holds ONE conversation spanning all tabs
///   (no goal), re-grounds on the current tab each turn, and checks in with a
///   colleague (a tab's own page-discussion agent) via the consult endpoint.
/// - `drafter`: the Prompt Drafter discussion agent — prompt-crafting
///   collaborator persona, the live-doc re-read discipline, and the tracked
///   write-suggestions contract (append/replace/insert/delete by block id).
/// - `companion`: the global cross-surface Companion — the spanning-app
///   discipline, the while-you-were-away journal feed, the global consult
///   contract, and memory/lineage retrieval.
/// - `redline-code-review`: the code-review loop — the blocking review curl, the
///   line-anchored feedback format, and the REDLINE_REVIEW_RESOLUTIONS reply.
/// - `classmemory`: the ClassMemory classifier + retrieval contract (the lake's
///   catalog).
/// - `librarian`: the on-demand friction-reduction agent that stewards the
///   prompt/context library and emits a prioritized next-actions checklist.
/// - `sensei`: the Dojo recruit contract — how an external model grounds
///   classes-first on the user's lake + ClassMemory (over MCP) to work like them.
const SKILLS: &[EmbeddedSkill] = &[
    EmbeddedSkill {
        name: "redline-plan-review",
        version: 10,
        content: include_str!("../../skills/redline-plan-review/SKILL.md"),
    },
    EmbeddedSkill {
        name: "sidecar",
        version: 2,
        content: include_str!("../../skills/sidecar/SKILL.md"),
    },
    EmbeddedSkill {
        name: "conversation",
        version: 2,
        content: include_str!("../../skills/conversation/SKILL.md"),
    },
    EmbeddedSkill {
        name: "browse",
        version: 6,
        content: include_str!("../../skills/browse/SKILL.md"),
    },
    EmbeddedSkill {
        name: "mission",
        version: 3,
        content: include_str!("../../skills/mission/SKILL.md"),
    },
    EmbeddedSkill {
        name: "linked",
        version: 2,
        content: include_str!("../../skills/linked/SKILL.md"),
    },
    EmbeddedSkill {
        name: "drafter",
        version: 2,
        content: include_str!("../../skills/drafter/SKILL.md"),
    },
    EmbeddedSkill {
        name: "companion",
        version: 2,
        content: include_str!("../../skills/companion/SKILL.md"),
    },
    EmbeddedSkill {
        name: "redline-code-review",
        version: 3,
        content: include_str!("../../skills/redline-code-review/SKILL.md"),
    },
    EmbeddedSkill {
        name: "classmemory",
        version: 2,
        content: include_str!("../../skills/classmemory/SKILL.md"),
    },
    EmbeddedSkill {
        name: "librarian",
        version: 2,
        content: include_str!("../../skills/librarian/SKILL.md"),
    },
    EmbeddedSkill {
        name: "context-analysis",
        version: 2,
        content: include_str!("../../skills/context-analysis/SKILL.md"),
    },
    EmbeddedSkill {
        name: "sensei",
        version: 1,
        content: include_str!("../../skills/sensei/SKILL.md"),
    },
];

/// The version reported in the aggregate status — the redline skill is the
/// anchor users recognize, so its version stands in for the bundle.
const SKILL_VERSION: u32 = SKILLS[0].version;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    /// Every shipped skill exists AND its content matches the version Redline
    /// ships. The setup modal advances only when this is true.
    pub installed: bool,
    /// Absolute path to `~/.claude/skills/redline-plan-review/SKILL.md` (always
    /// reported). The modal shows one path; the plan-review skill is the anchor.
    pub skill_path: String,
    /// At least one shipped `SKILL.md` is present but its content differs from
    /// the shipped version — installing will overwrite it. The skill analogue of
    /// `HookStatus`'s `conflicting_url`.
    pub outdated: bool,
    /// Skill version Redline would install (the redline-skill version stands in
    /// for the bundle).
    pub version: u32,
}

/// HOME-env resolution for `~/.claude/skills`, mirroring `hook::settings_path()`.
fn skills_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("skills")
}

/// A user-authored skill discovered at runtime from `~/.redline/skills/`.
/// Installed to `~/.claude/skills/<name>/SKILL.md` exactly like the built-ins,
/// but exempt from the byte-equality version lock: presence at the destination
/// counts as installed, and a diverged copy never flags the bundle `outdated`.
#[derive(Debug, Clone, PartialEq)]
pub struct UserSkill {
    pub name: String,
    pub content: String,
}

/// HOME-env resolution for `~/.redline/skills` — the user-skills source dir.
fn user_skills_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".redline").join("skills")
}

/// Discover user skills under `dir` (`<dir>/<name>/SKILL.md`). A name that
/// collides with a shipped skill is skipped — built-ins always win, so a user
/// file can never shadow the plan-review contract. Empty files are ignored.
/// A missing directory is simply "no user skills", never an error.
pub fn discover_user_skills_under(dir: &std::path::Path) -> Vec<UserSkill> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKILLS.iter().any(|s| s.name == name) {
            continue;
        }
        if let Ok(content) = fs::read_to_string(path.join("SKILL.md")) {
            if !content.trim().is_empty() {
                out.push(UserSkill { name, content });
            }
        }
    }
    // read_dir order is filesystem-dependent; sort for a stable install order.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn discover_user_skills() -> Vec<UserSkill> {
    discover_user_skills_under(&user_skills_root())
}

/// Per-skill install state at a path: `Ok(true)` installed-and-current,
/// `Ok(false)` present-but-stale, `Err` absent. Byte-equality, not existence —
/// an existence-only check would report a stale file as installed after a
/// version bump.
fn is_current(skill: &EmbeddedSkill, path: &std::path::Path) -> Result<bool, ()> {
    match fs::read_to_string(path) {
        Ok(content) if content == skill.content => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(()),
    }
}

pub fn get_status() -> SkillStatus {
    get_status_under(&skills_root(), &discover_user_skills())
}

/// Aggregate status across every shipped skill plus discovered user skills,
/// resolving each under `root` (`<root>/<name>/SKILL.md`). `installed` requires
/// all built-ins current AND all user skills present; `outdated` is set if any
/// present built-in file is stale. User skills are exempt from the byte-equality
/// lock: existence at the destination is enough, and a diverged destination copy
/// never sets `outdated` (the user may be iterating on it in place).
pub fn get_status_under(root: &std::path::Path, user: &[UserSkill]) -> SkillStatus {
    let mut all_current = true;
    let mut any_outdated = false;
    for skill in SKILLS {
        match is_current(skill, &root.join(skill.name).join("SKILL.md")) {
            Ok(true) => {}
            Ok(false) => {
                all_current = false;
                any_outdated = true;
            }
            Err(()) => all_current = false,
        }
    }
    for skill in user {
        if !root.join(&skill.name).join("SKILL.md").is_file() {
            all_current = false;
        }
    }
    SkillStatus {
        installed: all_current,
        skill_path: root
            .join(SKILLS[0].name)
            .join("SKILL.md")
            .to_string_lossy()
            .to_string(),
        outdated: any_outdated,
        version: SKILL_VERSION,
    }
}

pub fn install() -> Result<SkillStatus, String> {
    install_under(&skills_root(), &discover_user_skills())
}

/// One card in the settings Skills panel. Built-ins are the opinionated
/// defaults that teach the format; user skills are the freely-editable copies
/// living under `~/.redline/skills/`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCard {
    pub name: String,
    pub builtin: bool,
    /// Bundle version — built-ins only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// Editable source path — user skills only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The frontmatter `description:` scalar's first line, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The first line of the frontmatter `description:` — enough for a card
/// subtitle. Handles both inline scalars (`description: text`) and the
/// block-scalar form (`description: >-` followed by indented lines).
fn frontmatter_description(content: &str) -> Option<String> {
    let mut lines = content.lines().take(40).peekable();
    while let Some(line) = lines.next() {
        let Some(rest) = line.strip_prefix("description:") else {
            continue;
        };
        let inline = rest.trim();
        let text = if inline.is_empty() || inline.starts_with('>') || inline.starts_with('|') {
            lines
                .peek()
                .map(|l| l.trim().to_string())
                .unwrap_or_default()
        } else {
            inline.to_string()
        };
        if text.is_empty() {
            return None;
        }
        let mut out = text;
        if out.len() > 140 {
            out.truncate(140);
        }
        return Some(out);
    }
    None
}

/// Cards for every built-in plus the user skills discovered under `user_dir`.
pub fn list_cards_under(user_dir: &std::path::Path) -> Vec<SkillCard> {
    let mut out: Vec<SkillCard> = SKILLS
        .iter()
        .map(|s| SkillCard {
            name: s.name.to_string(),
            builtin: true,
            version: Some(s.version),
            path: None,
            description: frontmatter_description(s.content),
        })
        .collect();
    for user in discover_user_skills_under(user_dir) {
        out.push(SkillCard {
            name: user.name.clone(),
            builtin: false,
            version: None,
            path: Some(
                user_dir
                    .join(&user.name)
                    .join("SKILL.md")
                    .to_string_lossy()
                    .into_owned(),
            ),
            description: frontmatter_description(&user.content),
        });
    }
    out
}

/// Duplicate a built-in skill into `<user_dir>/my-<name>/SKILL.md`, where it
/// is freely editable (user skills are presence-only — never clobbered on
/// reinstall). Remixing an opinionated default beats authoring from scratch,
/// so the copy is byte-faithful except the frontmatter `name:` line, which is
/// retargeted so the duplicate never masquerades as the shipped skill.
pub fn duplicate_skill_under(user_dir: &std::path::Path, name: &str) -> Result<String, String> {
    let skill = SKILLS
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("unknown built-in skill: {name}"))?;
    let new_name = format!("my-{name}");
    let dest = user_dir.join(&new_name);
    if dest.join("SKILL.md").is_file() {
        return Err(format!("{new_name} already exists — edit it in place"));
    }
    let mut content = String::with_capacity(skill.content.len());
    let mut renamed = false;
    for line in skill.content.split_inclusive('\n') {
        if !renamed && line.trim_end() == format!("name: {name}") {
            content.push_str(&format!("name: {new_name}\n"));
            renamed = true;
        } else {
            content.push_str(line);
        }
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    fs::write(dest.join("SKILL.md"), content).map_err(|e| e.to_string())?;
    Ok(new_name)
}

/// Tauri command: cards for the settings Skills panel.
#[tauri::command]
pub fn list_skill_cards() -> Vec<SkillCard> {
    list_cards_under(&user_skills_root())
}

/// Tauri command: duplicate a built-in into `~/.redline/skills/` and return
/// the new skill's name. The frontend follows up with `install_skill` so the
/// copy syncs to `~/.claude/skills` like any user skill.
#[tauri::command]
pub fn duplicate_skill(name: String) -> Result<String, String> {
    duplicate_skill_under(&user_skills_root(), &name)
}

/// Write every embedded skill plus the given user skills under `root`
/// (`<root>/<name>/SKILL.md`), creating directories as needed. Idempotent by
/// overwrite — a skill is a whole-file artifact Redline owns, so (unlike the
/// hook's JSON merge into a user-owned `settings.json`) there is nothing to
/// preserve; re-running writes identical bytes. A user skill whose destination
/// already exists is left alone (the source under `~/.redline/skills` may be
/// older than in-place edits at the destination — never clobber those).
pub fn install_under(root: &std::path::Path, user: &[UserSkill]) -> Result<SkillStatus, String> {
    for skill in SKILLS {
        let path = root.join(skill.name).join("SKILL.md");
        if let Some(parent) = path.parent() {
            // For a skill the directory *is* the deliverable — surface a mkdir
            // failure rather than swallowing it.
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, skill.content).map_err(|e| e.to_string())?;
    }
    for skill in user {
        let path = root.join(&skill.name).join("SKILL.md");
        if path.is_file() {
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, &skill.content).map_err(|e| e.to_string())?;
    }
    Ok(get_status_under(root, user))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("redline-skill-{}", uuid::Uuid::new_v4()))
    }

    /// `<root>/<name>/SKILL.md` — the layout `get_status_under`/`install_under`
    /// resolve against.
    fn skill_md(root: &std::path::Path, name: &str) -> std::path::PathBuf {
        root.join(name).join("SKILL.md")
    }

    #[test]
    fn every_skill_is_non_empty_and_has_frontmatter() {
        for skill in SKILLS {
            assert!(
                !skill.content.trim().is_empty(),
                "embedded SKILL.md for `{}` is empty — include_str! wiring is broken",
                skill.name
            );
            assert!(
                skill.content.contains(&format!("name: {}", skill.name)),
                "embedded SKILL.md for `{}` is missing its frontmatter name",
                skill.name
            );
        }
    }

    #[test]
    fn redline_skill_carries_the_resolution_contract() {
        let redline = SKILLS
            .iter()
            .find(|s| s.name == "redline-plan-review")
            .unwrap();
        assert!(
            redline.content.contains("REDLINE_RESOLUTIONS"),
            "redline SKILL.md is missing the resolution-block contract"
        );
    }

    #[test]
    fn sidecar_skill_states_its_constraints() {
        let sidecar = SKILLS.iter().find(|s| s.name == "sidecar").unwrap();
        // The sidecar skill must teach the rich formats and the read-only rule.
        assert!(sidecar.content.contains("mermaid"));
        assert!(sidecar.content.contains("ExitPlanMode"));
    }

    #[test]
    fn conversation_skill_keeps_the_readonly_rule() {
        let convo = SKILLS.iter().find(|s| s.name == "conversation").unwrap();
        // Conversation mode changes voice, never permissions — the read-only
        // guardrail must survive the persona swap.
        assert!(convo.content.contains("ExitPlanMode"));
        assert!(convo.content.contains("read-only"));
    }

    #[test]
    fn linked_skill_teaches_the_consult_contract() {
        let linked = SKILLS.iter().find(|s| s.name == "linked").unwrap();
        // The linked skill must teach the "check in with a colleague" delegation.
        assert!(linked.content.contains("/v1/linked/consult"));
        assert!(linked.content.contains("digest"));
    }

    #[test]
    fn classmemory_skill_teaches_ops_and_retrieval() {
        let cm = SKILLS.iter().find(|s| s.name == "classmemory").unwrap();
        // The classifier contract: the seven ops + proposals-only + provenance,
        // plus the retrieval rules for supersession and observations. "seven
        // ops" keeps the skill and the parser in lockstep — adding an op must
        // touch both, and a revert to "six" trips this.
        for needle in [
            "proposals",
            "promote",
            "collapse",
            "cite_seqs",
            "ground truth",
            "/v1/memory/tree",
            "seven ops",
            "supersede",
            "old_seq",
            "supersededBy",
            "observations",
        ] {
            assert!(
                cm.content.contains(needle),
                "classmemory SKILL.md is missing `{needle}`"
            );
        }
    }

    #[test]
    fn librarian_skill_teaches_checklist_and_priority() {
        let lib = SKILLS.iter().find(|s| s.name == "librarian").unwrap();
        // The friction agent's contract: the checklist output, the priority
        // categories, on-demand-only, and the do-not-fabricate rule.
        for needle in [
            "checklist",
            "held_proposal",
            "stalled_review",
            "unstructured_backlog",
            "on-demand",
            "un_exported", // F6: real Phase-4 signal, now surfaced (was deferred)
        ] {
            assert!(
                lib.content.contains(needle),
                "librarian SKILL.md is missing `{needle}`"
            );
        }
    }

    #[test]
    fn context_analysis_skill_teaches_the_mcp_tools() {
        let ca = SKILLS.iter().find(|s| s.name == "context-analysis").unwrap();
        // The external-session MCP contract: the four tools + read-only + the
        // localhost boundary.
        for needle in [
            "query_prompts",
            "session_history",
            "memory_tree",
            "stats",
            "read-only",
            "127.0.0.1",
        ] {
            assert!(
                ca.content.contains(needle),
                "context-analysis SKILL.md is missing `{needle}`"
            );
        }
    }

    /// Extract the `<!-- CLASS-ROUTER:BEGIN -->…<!-- CLASS-ROUTER:END -->` block
    /// from a skill body. Returns `None` if either sentinel is missing.
    fn class_router_block(content: &str) -> Option<&str> {
        let begin = content.find("<!-- CLASS-ROUTER:BEGIN")?;
        let end = content.find("<!-- CLASS-ROUTER:END")?;
        content.get(begin..end)
    }

    #[test]
    fn sidecar_and_conversation_share_a_byte_identical_class_router() {
        // The class-router + ClassMemory-retrieval guidance is authored ONCE and
        // pasted into both discussion skills; this guard fails the build if they
        // drift, so a fix to one can never silently miss the other.
        let sidecar = SKILLS.iter().find(|s| s.name == "sidecar").unwrap();
        let convo = SKILLS.iter().find(|s| s.name == "conversation").unwrap();
        let a = class_router_block(sidecar.content)
            .expect("sidecar SKILL.md is missing the CLASS-ROUTER sentinels");
        let b = class_router_block(convo.content)
            .expect("conversation SKILL.md is missing the CLASS-ROUTER sentinels");
        assert!(a.len() > 500, "the shared block should be substantial");
        assert_eq!(
            a, b,
            "the sidecar and conversation class-router blocks must be byte-identical"
        );
        // And it must actually carry the router + retrieval contract.
        assert!(a.contains("resolve the likely class"));
        assert!(a.contains("/v1/memory/tree"));
        assert!(a.contains("what did I *decide*"));
    }

    #[test]
    fn sensei_skill_teaches_the_recruit_contract() {
        let sensei = SKILLS.iter().find(|s| s.name == "sensei").unwrap();
        // The Dojo recruit contract: the box fields, classes-first grounding over
        // the ClassMemory catalog, the MCP boundary, and the read-only rule.
        for needle in [
            "Recruit Reason",
            "Recruit Function",
            "classes-first",
            "memory_tree",
            "127.0.0.1",
            "read-only",
        ] {
            assert!(
                sensei.content.contains(needle),
                "sensei SKILL.md is missing `{needle}`"
            );
        }
    }

    #[test]
    fn version_constants_match_frontmatter() {
        // Each skill's `version` const and its SKILL.md `version:` field must not
        // drift — a bump in one without the other breaks upgrade detection.
        for skill in SKILLS {
            assert!(
                skill
                    .content
                    .contains(&format!("version: {}\n", skill.version)),
                "version const for `{}` ({}) does not match its SKILL.md frontmatter",
                skill.name,
                skill.version
            );
        }
    }

    #[test]
    fn install_creates_files_and_parent_dirs_for_all_skills() {
        let root = tmpdir();
        let status = install_under(&root, &[]).unwrap();
        assert!(status.installed);
        assert!(!status.outdated);
        assert_eq!(status.version, SKILL_VERSION);
        for skill in SKILLS {
            let path = skill_md(&root, skill.name);
            assert!(path.exists(), "{} not installed", skill.name);
            assert_eq!(fs::read_to_string(&path).unwrap(), skill.content);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_is_idempotent() {
        let root = tmpdir();
        install_under(&root, &[]).unwrap();
        let status = install_under(&root, &[]).unwrap();
        assert!(status.installed);
        assert!(!status.outdated);
        for skill in SKILLS {
            assert_eq!(
                fs::read_to_string(skill_md(&root, skill.name)).unwrap(),
                skill.content
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn aggregate_outdated_when_only_sidecar_is_stale() {
        // Guards the upgrade path: an existing user has a current redline skill
        // but no/stale sidecar → the bundle reads as not-installed + outdated,
        // which re-shows the setup modal.
        let root = tmpdir();
        install_under(&root, &[]).unwrap();
        fs::write(skill_md(&root, "sidecar"), "stale skill content").unwrap();

        let status = get_status_under(&root, &[]);
        assert!(!status.installed, "a stale sidecar must break `installed`");
        assert!(status.outdated, "a stale sidecar must set `outdated`");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn aggregate_not_installed_when_a_skill_is_missing() {
        let root = tmpdir();
        install_under(&root, &[]).unwrap();
        fs::remove_dir_all(root.join("sidecar")).unwrap();

        let status = get_status_under(&root, &[]);
        assert!(!status.installed);
        // Missing (not present-but-stale) does not set `outdated`.
        assert!(!status.outdated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn status_reports_missing_when_absent() {
        let root = tmpdir();
        let status = get_status_under(&root, &[]);
        assert!(!status.installed);
        assert!(!status.outdated);
        // Nothing was created — no cleanup needed.
    }

    #[test]
    fn install_overwrites_outdated_files() {
        let root = tmpdir();
        for skill in SKILLS {
            let path = skill_md(&root, skill.name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "stale skill content").unwrap();
        }
        assert!(get_status_under(&root, &[]).outdated);

        let status = install_under(&root, &[]).unwrap();
        assert!(status.installed);
        assert!(!status.outdated);
        for skill in SKILLS {
            assert_eq!(
                fs::read_to_string(skill_md(&root, skill.name)).unwrap(),
                skill.content
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    // ---- User skills (~/.redline/skills) ------------------------------------

    fn user_skill(name: &str) -> UserSkill {
        UserSkill {
            name: name.to_string(),
            content: format!("---\nname: {name}\n---\n\nMy custom skill.\n"),
        }
    }

    #[test]
    fn discover_skips_builtin_collisions_empty_files_and_missing_dir() {
        let src = tmpdir();
        // Missing directory → no user skills, no error.
        assert!(discover_user_skills_under(&src).is_empty());

        // A real skill, a built-in-shadowing skill, and an empty one.
        for (name, content) in [
            ("my-workflow", "custom content"),
            ("redline-plan-review", "shadow attempt"),
            ("empty-one", "   \n"),
        ] {
            let dir = src.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), content).unwrap();
        }
        // A stray file (not a dir) must be ignored too.
        fs::write(src.join("stray.md"), "not a skill dir").unwrap();

        let found = discover_user_skills_under(&src);
        assert_eq!(found.len(), 1, "only the real user skill should survive");
        assert_eq!(found[0].name, "my-workflow");
        assert_eq!(found[0].content, "custom content");
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn install_writes_user_skills_and_status_requires_their_presence() {
        let root = tmpdir();
        let user = vec![user_skill("my-workflow")];

        let status = install_under(&root, &user).unwrap();
        assert!(status.installed);
        assert_eq!(
            fs::read_to_string(skill_md(&root, "my-workflow")).unwrap(),
            user[0].content
        );

        // Remove the installed user skill → aggregate no longer installed,
        // but not `outdated` (missing ≠ stale, same as built-ins).
        fs::remove_dir_all(root.join("my-workflow")).unwrap();
        let status = get_status_under(&root, &user);
        assert!(!status.installed);
        assert!(!status.outdated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn user_skills_are_exempt_from_the_byte_equality_lock() {
        let root = tmpdir();
        let user = vec![user_skill("my-workflow")];
        install_under(&root, &user).unwrap();

        // Diverge the installed copy — e.g. the user iterated on it in place.
        fs::write(skill_md(&root, "my-workflow"), "edited at destination").unwrap();
        let status = get_status_under(&root, &user);
        assert!(status.installed, "presence is enough for a user skill");
        assert!(!status.outdated, "a diverged user skill must not flag outdated");

        // Re-installing must NOT clobber the destination edits.
        install_under(&root, &user).unwrap();
        assert_eq!(
            fs::read_to_string(skill_md(&root, "my-workflow")).unwrap(),
            "edited at destination"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cards_list_builtins_then_user_skills_with_descriptions() {
        let dir = tmpdir();
        fs::create_dir_all(dir.join("my-notes")).unwrap();
        fs::write(
            skill_md(&dir, "my-notes"),
            "---\nname: my-notes\ndescription: Take notes my way.\n---\nbody",
        )
        .unwrap();

        let cards = list_cards_under(&dir);
        assert_eq!(cards.len(), SKILLS.len() + 1);
        let browse = cards.iter().find(|c| c.name == "browse").unwrap();
        assert!(browse.builtin);
        assert_eq!(browse.version, Some(6));
        assert!(browse.path.is_none());
        // Block-scalar (`description: >-`) frontmatter still yields a subtitle.
        assert!(browse.description.as_deref().unwrap().starts_with("Discussing"));
        let mine = cards.iter().find(|c| c.name == "my-notes").unwrap();
        assert!(!mine.builtin);
        assert_eq!(mine.version, None);
        assert!(mine.path.as_deref().unwrap().ends_with("my-notes/SKILL.md"));
        assert_eq!(mine.description.as_deref(), Some("Take notes my way."));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_copies_a_builtin_and_retargets_its_frontmatter_name() {
        let dir = tmpdir();
        let new_name = duplicate_skill_under(&dir, "browse").unwrap();
        assert_eq!(new_name, "my-browse");
        let content = fs::read_to_string(skill_md(&dir, "my-browse")).unwrap();
        assert!(content.starts_with("---\nname: my-browse\n"));
        // Byte-faithful apart from the name line.
        let original = SKILLS.iter().find(|s| s.name == "browse").unwrap().content;
        assert_eq!(
            content.replacen("name: my-browse", "name: browse", 1),
            original
        );
        // The duplicate is now discoverable as a user skill.
        assert!(discover_user_skills_under(&dir)
            .iter()
            .any(|s| s.name == "my-browse"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_rejects_unknown_names_and_existing_copies() {
        let dir = tmpdir();
        assert!(duplicate_skill_under(&dir, "no-such-skill").is_err());
        duplicate_skill_under(&dir, "browse").unwrap();
        let err = duplicate_skill_under(&dir, "browse").unwrap_err();
        assert!(err.contains("already exists"));
        let _ = fs::remove_dir_all(&dir);
    }
}

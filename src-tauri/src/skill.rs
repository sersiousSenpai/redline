// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::fs;
use std::path::PathBuf;

use serde::Serialize;

/// The canonical Redline review-protocol skill, embedded at compile time. The
/// source of truth is `skills/redline/SKILL.md` at the repo root (the in-repo
/// `.agents/skills/redline` path is a symlink to it; there is deliberately no
/// `.claude/skills` copy — the app installs to `~/.claude`, and a project-level
/// copy would register the skill twice in Claude Code sessions inside this
/// repo). `install` writes this exact content to
/// `~/.claude/skills/redline/SKILL.md` so every Claude Code session that
/// reaches Redline is fluent in the contract.
///
/// `include_str!` resolves relative to this source file (`src-tauri/src/`), so
/// `../../` is the repo root. A missing canonical file fails the build — the
/// intended fail-fast.
const EMBEDDED_SKILL: &str = include_str!("../../skills/redline/SKILL.md");

/// Bump in lockstep with the `version:` field in `skills/redline/SKILL.md`.
/// `version_constant_matches_frontmatter` asserts the two never drift.
const SKILL_VERSION: u32 = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    /// The skill file exists AND its content matches the version Redline ships.
    pub installed: bool,
    /// Absolute path to `~/.claude/skills/redline/SKILL.md` (always reported).
    pub skill_path: String,
    /// A `SKILL.md` is present but its content differs from the shipped version
    /// — installing will overwrite it. The skill analogue of `HookStatus`'s
    /// `conflicting_url`.
    pub outdated: bool,
    /// Skill version Redline would install.
    pub version: u32,
}

/// `~/.claude/skills/redline/SKILL.md` — HOME-env resolution, mirroring
/// `hook::settings_path()`.
pub fn skill_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude")
        .join("skills")
        .join("redline")
        .join("SKILL.md")
}

pub fn get_status() -> SkillStatus {
    get_status_at(&skill_path())
}

pub fn get_status_at(path: &std::path::Path) -> SkillStatus {
    let skill_path = path.to_string_lossy().to_string();
    // `installed` is decided by byte-equality with the embedded skill — an
    // existence-only check would report a stale file as installed after a
    // version bump.
    match fs::read_to_string(path) {
        Ok(content) if content == EMBEDDED_SKILL => SkillStatus {
            installed: true,
            skill_path,
            outdated: false,
            version: SKILL_VERSION,
        },
        Ok(_) => SkillStatus {
            installed: false,
            skill_path,
            outdated: true,
            version: SKILL_VERSION,
        },
        Err(_) => SkillStatus {
            installed: false,
            skill_path,
            outdated: false,
            version: SKILL_VERSION,
        },
    }
}

pub fn install() -> Result<SkillStatus, String> {
    install_at(&skill_path())
}

/// Write the embedded skill, creating `~/.claude/skills/redline/` as needed.
/// Idempotent by overwrite — a skill is a whole-file artifact Redline owns, so
/// (unlike the hook's JSON merge into a user-owned `settings.json`) there is
/// nothing to preserve; re-running writes identical bytes.
pub fn install_at(path: &std::path::Path) -> Result<SkillStatus, String> {
    if let Some(parent) = path.parent() {
        // For a skill the directory *is* the deliverable — surface a mkdir
        // failure rather than swallowing it.
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, EMBEDDED_SKILL).map_err(|e| e.to_string())?;
    Ok(get_status_at(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("redline-skill-{}", uuid::Uuid::new_v4()))
    }

    fn skill_md(root: &std::path::Path) -> std::path::PathBuf {
        root.join("skills").join("redline").join("SKILL.md")
    }

    #[test]
    fn embedded_skill_is_non_empty_and_has_frontmatter() {
        assert!(
            !EMBEDDED_SKILL.trim().is_empty(),
            "embedded SKILL.md is empty — include_str! wiring is broken"
        );
        assert!(
            EMBEDDED_SKILL.contains("name: redline"),
            "embedded SKILL.md is missing its frontmatter name"
        );
        assert!(
            EMBEDDED_SKILL.contains("REDLINE_RESOLUTIONS"),
            "embedded SKILL.md is missing the resolution-block contract"
        );
    }

    #[test]
    fn version_constant_matches_frontmatter() {
        // SKILL_VERSION and the SKILL.md `version:` field must not drift.
        assert!(
            EMBEDDED_SKILL.contains(&format!("version: {SKILL_VERSION}\n")),
            "SKILL_VERSION ({SKILL_VERSION}) does not match the SKILL.md frontmatter"
        );
    }

    #[test]
    fn install_creates_file_and_parent_dirs() {
        let root = tmpdir();
        let path = skill_md(&root);
        let status = install_at(&path).unwrap();
        assert!(status.installed);
        assert!(!status.outdated);
        assert_eq!(status.version, SKILL_VERSION);
        assert!(path.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), EMBEDDED_SKILL);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_is_idempotent() {
        let root = tmpdir();
        let path = skill_md(&root);
        install_at(&path).unwrap();
        let status = install_at(&path).unwrap();
        assert!(status.installed);
        assert!(!status.outdated);
        assert_eq!(fs::read_to_string(&path).unwrap(), EMBEDDED_SKILL);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn status_reports_outdated_for_mismatched_content() {
        let root = tmpdir();
        let path = skill_md(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "stale skill content").unwrap();
        let status = get_status_at(&path);
        assert!(!status.installed);
        assert!(status.outdated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn status_reports_missing_when_absent() {
        let root = tmpdir();
        let status = get_status_at(&skill_md(&root));
        assert!(!status.installed);
        assert!(!status.outdated);
        // Nothing was created — no cleanup needed.
    }

    #[test]
    fn install_overwrites_outdated_file() {
        let root = tmpdir();
        let path = skill_md(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "stale skill content").unwrap();
        assert!(get_status_at(&path).outdated);

        let status = install_at(&path).unwrap();
        assert!(status.installed);
        assert!(!status.outdated);
        assert_eq!(fs::read_to_string(&path).unwrap(), EMBEDDED_SKILL);
        let _ = fs::remove_dir_all(&root);
    }
}

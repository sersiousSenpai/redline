// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Make the project.
//!
//! `projectOptions` in the frontend is derived entirely from existing review
//! sessions and open folder workspaces, so on a genuine first run it is
//! **empty** and the picker offers only `Home (~)` and `Browse…`. A
//! first-time builder's first build therefore lands in `$HOME`, and nothing in
//! the app can create a project for them. This is that missing verb.
//!
//! `slugify_project_name` is the security boundary — it is a pure function
//! precisely so it can be exhaustively tested. Everything it accepts becomes a
//! single directory component under a parent Redline chose.

use std::path::{Path, PathBuf};

/// A proposed name may not exceed this many characters once slugified. Long
/// enough for a real project, short enough that no filesystem complains.
const MAX_SLUG: usize = 64;

/// Turn a human-typed name into ONE safe directory component, or refuse.
///
/// Lowercase; whitespace becomes `-`; anything outside `[a-z0-9._-]` is
/// dropped. Refusals — never silent rewrites — for anything that could escape
/// the parent: a path separator of either flavour, `.`/`..`, or an empty
/// result. Leading/trailing dots and dashes are trimmed so no hidden
/// directory is created by accident.
pub fn slugify_project_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A separator is a *refusal*, not something to strip: silently turning
    // "../etc" into "etc" would create a directory the user never asked for.
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return None;
    }
    let mut slug = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for ch in trimmed.chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else if ch.is_whitespace() || ch == '-' || ch == '_' {
            '-'
        } else if ch == '.' {
            '.'
        } else {
            continue;
        };
        if mapped == '-' {
            if last_dash || slug.is_empty() {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        slug.push(mapped);
        if slug.len() >= MAX_SLUG {
            break;
        }
    }
    let slug = slug.trim_matches(|c| c == '-' || c == '.').to_string();
    if slug.is_empty() || slug == "." || slug == ".." {
        return None;
    }
    Some(slug)
}

/// Where a new project goes when the caller doesn't say: `~/Projects` if the
/// user already keeps projects there, else `$HOME`. Never invents `~/Projects`
/// on a machine that doesn't use it.
fn default_parent() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let projects = home.join("Projects");
    if projects.is_dir() {
        projects
    } else {
        home
    }
}

/// True when `dir` holds something the user would miss. `.DS_Store` alone is
/// an empty folder that Finder happened to visit, not someone's work.
fn has_contents(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        // Unreadable: treat as occupied. Refusing is the safe direction.
        return true;
    };
    entries
        .flatten()
        .any(|e| e.file_name() != std::ffi::OsString::from(".DS_Store"))
}

/// `git init`, best-effort. `/usr/bin/git` is the CLT shim (matching
/// `worktree.rs`'s rationale) — a Finder-launched app has a minimal PATH, and
/// a PATH lookup would miss. A failure is non-fatal: you still get a folder.
async fn git_init(dir: &Path) {
    let _ = tokio::process::Command::new("/usr/bin/git")
        .arg("init")
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Create a project directory and return its absolute path.
///
/// The folder is seeded with a one-line `README.md` so it isn't empty and
/// `guessProjectForPlan` has a name to match on later.
#[tauri::command(async)]
pub async fn project_create(parent: Option<String>, name: String) -> Result<String, String> {
    let slug = slugify_project_name(&name)
        .ok_or_else(|| format!("\"{}\" isn't a usable folder name", name.trim()))?;
    let parent_dir = match parent.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_parent(),
    };
    let target = parent_dir.join(&slug);

    if target.exists() {
        if !target.is_dir() {
            return Err(format!("{} already exists and isn't a folder", target.display()));
        }
        // Never write into someone's directory.
        if has_contents(&target) {
            return Err(format!("{} already exists and isn't empty", target.display()));
        }
    }

    std::fs::create_dir_all(&target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;

    let readme = target.join("README.md");
    if !readme.exists() {
        let title = name.trim();
        let title = if title.is_empty() { slug.as_str() } else { title };
        let _ = std::fs::write(&readme, format!("# {title}\n"));
    }

    git_init(&target).await;

    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_the_ordinary_cases() {
        assert_eq!(slugify_project_name("Dark Mode Toggle").as_deref(), Some("dark-mode-toggle"));
        assert_eq!(slugify_project_name("dark-mode-toggle").as_deref(), Some("dark-mode-toggle"));
        assert_eq!(slugify_project_name("  My  App  ").as_deref(), Some("my-app"));
        assert_eq!(slugify_project_name("qwallah_crm").as_deref(), Some("qwallah-crm"));
        assert_eq!(slugify_project_name("v2.1").as_deref(), Some("v2.1"));
    }

    #[test]
    fn drops_characters_outside_the_allowed_set() {
        assert_eq!(slugify_project_name("Build a *CRM* (v2)!").as_deref(), Some("build-a-crm-v2"));
        assert_eq!(slugify_project_name("café ☕").as_deref(), Some("caf"));
        assert_eq!(slugify_project_name("a$b&c").as_deref(), Some("abc"));
    }

    #[test]
    fn refuses_every_path_separator() {
        // The security boundary: a separator is refused outright, never
        // stripped into something that looks harmless.
        for name in [
            "../etc",
            "..",
            "../../etc/passwd",
            "a/b",
            "/absolute",
            "trailing/",
            "back\\slash",
            "..\\..\\windows",
            "~/Projects/x",
        ] {
            assert_eq!(slugify_project_name(name), None, "should refuse {name:?}");
        }
    }

    #[test]
    fn refuses_dot_names_and_empties() {
        for name in ["", "   ", ".", "..", "...", "!!!", "☕", "-", "---", ".-."] {
            assert_eq!(slugify_project_name(name), None, "should refuse {name:?}");
        }
    }

    #[test]
    fn never_creates_a_hidden_directory() {
        assert_eq!(slugify_project_name(".hidden").as_deref(), Some("hidden"));
        assert_eq!(slugify_project_name("..hidden").as_deref(), Some("hidden"));
        assert_eq!(slugify_project_name(".git").as_deref(), Some("git"));
    }

    #[test]
    fn output_is_always_one_safe_component() {
        let long = "x".repeat(200);
        for name in [
            "Dark Mode Toggle",
            ".hidden",
            "a....b",
            "A-----B",
            "9lives",
            "v2.1",
            long.as_str(),
        ] {
            let Some(slug) = slugify_project_name(name) else {
                continue;
            };
            assert!(!slug.is_empty());
            assert!(slug.len() <= MAX_SLUG, "{slug} too long");
            assert!(
                slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'),
                "{slug} has a disallowed char"
            );
            assert!(!slug.starts_with('.') && !slug.ends_with('.'));
            assert!(!slug.contains('/') && !slug.contains('\\'));
            assert_eq!(Path::new(&slug).components().count(), 1);
        }
    }

    #[test]
    fn caps_a_very_long_name() {
        let slug = slugify_project_name(&"word ".repeat(60)).unwrap();
        assert!(slug.len() <= MAX_SLUG);
        assert!(!slug.ends_with('-'));
    }

    #[test]
    fn has_contents_ignores_a_lone_ds_store() {
        let dir = std::env::temp_dir().join(format!("redline-project-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!has_contents(&dir));
        std::fs::write(dir.join(".DS_Store"), b"x").unwrap();
        assert!(!has_contents(&dir), "a lone .DS_Store is still an empty folder");
        std::fs::write(dir.join("notes.md"), b"x").unwrap();
        assert!(has_contents(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn has_contents_refuses_the_unreadable() {
        // A path that isn't a directory reads as occupied — refusing is the
        // safe direction when we can't tell.
        assert!(has_contents(Path::new("/definitely/not/a/directory")));
    }
}

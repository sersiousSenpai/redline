// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A repo's own logo, for the terminal tab strip.
//!
//! Tabs are text-only otherwise — `redline 3`, `zsh 1`, `qwallah 2` — so
//! finding one across a split dock is a read-every-word exercise. A small mark
//! in front of the label turns that into a glance.
//!
//! Two facts about a real `~` shaped this:
//!
//!   * **Most repos ship no logo.** Of the 60 project directories here, only
//!     ~19 had any logo-ish file at all. The fallback (a monogram, drawn on the
//!     frontend) is the common case, not the exception — so it has to look
//!     deliberate rather than like a broken image.
//!   * **Stock template icons are worse than nothing.** Six of those repos
//!     carry a byte-identical `app/favicon.ico` — the one `create-next-app`
//!     ships. A naive "find favicon.ico" would stamp the same generic mark on
//!     six different tabs, which reads as a bug. So a candidate whose sha256 is
//!     a known template hash is skipped and the search continues.
//!
//! The icon is anchored to the *repo*, not the cwd: `cd src` inside redline
//! keeps the redline logo while the label follows the directory. The icon says
//! which repo, the label says which folder.
//!
//! Delivery reuses the app's established image route — bytes → base64 →
//! `data:` URL → `<img>`. Tauri's asset protocol is off and `file://`
//! subresources are blocked in WKWebView, so this is the only path that works
//! (see `thumbs.rs`, `AttachmentChips.tsx`, `FileViewer.tsx`).

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::ledger::sha256_hex;

/// What one tab needs to draw its mark: which repo the terminal is in, and
/// that repo's logo if it ships a usable one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIcon {
    /// Absolute path of the repo root the cwd belongs to.
    pub root: String,
    /// Basename of `root` — what the frontend's monogram is derived from, so a
    /// logo-less repo still gets a stable, distinct color and letter.
    pub name: String,
    /// `data:<mime>;base64,…`, or `None` when the repo ships no usable logo.
    pub data_url: Option<String>,
}

/// How far up from a cwd we'll look for a repo root. Deep enough for a package
/// nested inside a monorepo, shallow enough that a pathological path can't turn
/// one tab label into a long walk.
const MAX_WALK_UP: usize = 24;

/// Rendered at 14 px. The generic `read_file_base64` cap (16 MB) is far too
/// loose for that — an oversized candidate is skipped, not fatal, and the
/// search moves to the next entry.
const MAX_ICON_BYTES: u64 = 512 * 1024;

/// Ordered relative paths; the first readable, non-stock, in-budget hit wins.
///
/// The ordering *is* the heuristic. A file the project deliberately calls its
/// logo beats a framework convention, which beats a favicon — `favicon.*` is
/// deliberately last, because it is the file most likely to still be whatever
/// the template scaffolded.
const CANDIDATES: &[&str] = &[
    "public/logo.svg",
    "public/logo.png",
    "public/icon.svg",
    "public/icon.png",
    "app/icon.svg",
    "app/icon.png",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    "static/logo.svg",
    "static/logo.png",
    ".github/logo.png",
    "src-tauri/icons/128x128.png",
    "logo.svg",
    "logo.png",
    "icon.svg",
    "icon.png",
    "public/favicon.svg",
    "public/favicon.png",
    "public/favicon.ico",
    "app/favicon.ico",
    "src/app/favicon.ico",
];

/// sha256 of icons that identify a *template*, not a project. Skipping these is
/// the difference between "six tabs, six marks" and "six tabs, one mark".
/// Deliberately extendable: the Vite / CRA / Tauri scaffold defaults belong here
/// too as they turn up.
const STOCK_ICON_HASHES: &[&str] = &[
    // The favicon `create-next-app` ships, byte-identical across six repos here.
    "2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932",
];

/// The repo a directory belongs to: the nearest ancestor (inclusive) holding a
/// `.git`, or `start` itself when there is none.
///
/// `has_git` is injected so the walk is testable without touching a disk — the
/// same shape as `devmap::resolve_project`.
pub fn project_root_with(start: &Path, has_git: impl Fn(&Path) -> bool) -> PathBuf {
    start
        .ancestors()
        .take(MAX_WALK_UP + 1)
        .find(|d| has_git(d))
        .map(Path::to_path_buf)
        .unwrap_or_else(|| start.to_path_buf())
}

/// [`project_root_with`] against the real filesystem. `.git` is tested with
/// `exists()` rather than `is_dir()` on purpose: in a linked worktree it is a
/// *file* pointing back at the main checkout, and a worktree is exactly the case
/// where you most want the icon to still say which repo you're in.
pub fn project_root(start: &Path) -> PathBuf {
    project_root_with(start, |d| d.join(".git").exists())
}

/// Does this look like a scaffolded template's icon rather than a project's?
pub fn is_stock(bytes: &[u8]) -> bool {
    STOCK_ICON_HASHES.contains(&sha256_hex(bytes).as_str())
}

/// The `data:` MIME for an image extension. Mirrors the table the file viewer
/// uses, minus the formats nobody ships a logo in.
pub fn mime_for(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// [`find_icon`] with the "this is a template's icon" test injected, so the
/// skip-and-continue behaviour can be exercised without a binary fixture.
fn find_icon_with(root: &Path, reject: impl Fn(&[u8]) -> bool) -> Option<String> {
    for rel in CANDIDATES {
        let path = root.join(rel);
        let Some(mime) = path.extension().and_then(|e| e.to_str()).and_then(mime_for) else {
            continue;
        };
        let Ok(meta) = fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes.is_empty() || reject(&bytes) {
            continue;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(format!("data:{mime};base64,{encoded}"));
    }
    None
}

/// Walk [`CANDIDATES`] in order and return the first usable one as a `data:`
/// URL. Every rejection — missing, a directory, oversized, unreadable, empty,
/// stock — *continues* the search rather than ending it, so one bad file in an
/// early slot can't hide a good one further down.
pub fn find_icon(root: &Path) -> Option<String> {
    find_icon_with(root, is_stock)
}

/// The mark for a terminal sitting in `cwd`. Never fails: a directory with no
/// repo and no logo still answers, and the frontend draws a monogram from
/// `name`.
///
/// `(async)` because it walks ancestors and hashes files — exactly the shape
/// that must not run on the WebView main thread (see `docs/perf-budget.md`).
#[tauri::command(async)]
pub fn repo_icon(cwd: String) -> RepoIcon {
    let root = project_root(Path::new(&cwd));
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    RepoIcon {
        data_url: find_icon(&root),
        root: root.to_string_lossy().into_owned(),
        name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("redline-repoicon-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn the_root_is_the_nearest_git_ancestor() {
        let git = |p: &Path| p == Path::new("/Users/me/redline");
        assert_eq!(
            project_root_with(Path::new("/Users/me/redline/src/components"), git),
            PathBuf::from("/Users/me/redline"),
        );
        // Inclusive: a cwd that IS the root resolves to itself.
        assert_eq!(
            project_root_with(Path::new("/Users/me/redline"), git),
            PathBuf::from("/Users/me/redline"),
        );
    }

    #[test]
    fn a_cwd_outside_any_repo_is_its_own_root() {
        assert_eq!(
            project_root_with(Path::new("/Users/me/Downloads"), |_| false),
            PathBuf::from("/Users/me/Downloads"),
        );
    }

    #[test]
    fn the_nearest_root_wins_over_a_higher_one() {
        // A package inside a monorepo shows the package's own mark, not the
        // umbrella repo's — the icon answers "which checkout am I in".
        let git = |p: &Path| {
            p == Path::new("/w/mono") || p == Path::new("/w/mono/packages/api")
        };
        assert_eq!(
            project_root_with(Path::new("/w/mono/packages/api/src"), git),
            PathBuf::from("/w/mono/packages/api"),
        );
    }

    #[test]
    fn the_walk_up_is_depth_bounded() {
        // A root further up than MAX_WALK_UP is not found; the tab falls back to
        // its own directory rather than paying an unbounded walk.
        let deep: String = (0..40).map(|i| format!("/d{i}")).collect();
        let found = project_root_with(Path::new(&deep), |p| p == Path::new("/d0"));
        assert_eq!(found, PathBuf::from(&deep));
    }

    #[test]
    fn favicons_are_searched_last_and_every_candidate_is_reachable() {
        let first_favicon = CANDIDATES
            .iter()
            .position(|c| c.contains("favicon"))
            .expect("the list still has favicon fallbacks");
        assert!(
            CANDIDATES[first_favicon..].iter().all(|c| c.contains("favicon")),
            "a non-favicon candidate sits after a favicon — favicons must stay \
             last resort, they are the file most likely to still be a template's"
        );
        let unique: HashSet<&&str> = CANDIDATES.iter().collect();
        assert_eq!(unique.len(), CANDIDATES.len(), "duplicate candidate path");
        for c in CANDIDATES {
            let ext = Path::new(c).extension().and_then(|e| e.to_str());
            assert!(
                ext.and_then(mime_for).is_some(),
                "candidate {c} has no MIME mapping, so it can never be picked"
            );
        }
    }

    #[test]
    fn mime_mapping_covers_the_image_types_and_rejects_the_rest() {
        assert_eq!(mime_for("svg"), Some("image/svg+xml"));
        assert_eq!(mime_for("PNG"), Some("image/png"));
        assert_eq!(mime_for("ico"), Some("image/x-icon"));
        assert_eq!(mime_for("jpeg"), Some("image/jpeg"));
        assert_eq!(mime_for("jpg"), Some("image/jpeg"));
        assert_eq!(mime_for("webp"), Some("image/webp"));
        assert_eq!(mime_for("avif"), Some("image/avif"));
        assert_eq!(mime_for("txt"), None);
        assert_eq!(mime_for("md"), None);
        assert_eq!(mime_for(""), None);
    }

    /// The blocklist is only as good as the digest that indexes it: a change of
    /// case or padding would silently stop matching every entry.
    #[test]
    fn the_stock_blocklist_is_well_formed_lowercase_sha256() {
        for h in STOCK_ICON_HASHES {
            assert_eq!(h.len(), 64, "{h} is not a sha256 hex digest");
            assert!(
                h.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
                "{h} must be lowercase hex to match sha256_hex output"
            );
        }
        assert!(
            STOCK_ICON_HASHES
                .contains(&"2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932"),
            "the create-next-app favicon must stay blocked — six repos here ship it"
        );
        assert_eq!(sha256_hex(b"abc").len(), 64);
        assert!(!is_stock(b"a real project's logo"));
        assert!(!is_stock(b""));
    }

    #[test]
    fn the_first_candidate_in_order_wins() {
        let root = tmpdir("order");
        write(&root.join("icon.png"), b"root-icon");
        write(&root.join("public/logo.svg"), b"<svg/>");
        let url = find_icon(&root).unwrap();
        assert!(
            url.starts_with("data:image/svg+xml;base64,"),
            "public/logo.svg outranks a root icon.png, got {url}"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_stock_icon_is_skipped_and_the_search_continues() {
        let root = tmpdir("stock");
        write(&root.join("public/favicon.ico"), b"THE-TEMPLATE-FAVICON");
        let stock = |b: &[u8]| b == b"THE-TEMPLATE-FAVICON";

        // Alone, it yields nothing — better no mark than the same mark on six
        // unrelated tabs.
        assert_eq!(find_icon_with(&root, stock), None);
        // The real predicate has no opinion about these bytes, which is what
        // makes the injected one the only difference.
        assert!(find_icon(&root).is_some());

        // A genuine logo further down the list is still found.
        write(&root.join("public/logo.png"), b"real");
        assert!(find_icon_with(&root, stock)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn oversized_empty_and_missing_candidates_are_all_skipped() {
        let root = tmpdir("skips");
        assert_eq!(find_icon(&root), None, "an empty repo has no mark");
        write(
            &root.join("public/logo.svg"),
            &vec![b'x'; MAX_ICON_BYTES as usize + 1],
        );
        write(&root.join("public/logo.png"), b"");
        write(&root.join("public/icon.svg"), b"<svg/>");
        assert!(
            find_icon(&root)
                .unwrap()
                .starts_with("data:image/svg+xml;base64,"),
            "an oversized and an empty candidate must not end the search"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_directory_named_like_a_candidate_is_not_an_icon() {
        let root = tmpdir("dir");
        fs::create_dir_all(root.join("public/logo.svg")).unwrap();
        write(&root.join("public/logo.png"), b"real");
        assert!(find_icon(&root)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_command_names_the_repo_it_resolved_not_the_cwd() {
        let root = tmpdir("cmd");
        fs::create_dir_all(root.join(".git")).unwrap();
        let nested = root.join("src/components");
        fs::create_dir_all(&nested).unwrap();
        write(&root.join("public/logo.svg"), b"<svg/>");

        let icon = repo_icon(nested.to_string_lossy().into_owned());
        assert_eq!(icon.root, root.to_string_lossy());
        assert_eq!(icon.name, root.file_name().unwrap().to_string_lossy());
        assert!(icon
            .data_url
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_linked_worktree_resolves_by_its_dot_git_file() {
        let root = tmpdir("worktree");
        // `git worktree add` writes a .git FILE, not a directory.
        write(
            &root.join(".git"),
            b"gitdir: /Users/me/redline/.git/worktrees/wt\n",
        );
        let nested = root.join("src-tauri/src");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(project_root(&nested), root);
        fs::remove_dir_all(&root).ok();
    }
}

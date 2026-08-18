// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Local-folder install (program A5a) — the dev loop under everything the
//! registry later bolts on. An install is a **symlink**: `<root>/<name>`
//! points at the author's own project folder, every scan reads the manifest
//! *through* the link, and so an edit in the project is live on the next
//! read with no watcher, no re-install, no restart. No registry, no sha256,
//! no index PR — the folder the user picked *is* the consent.
//!
//! Two artifact families ride the one mechanism:
//!
//! - a **harness pack** (`harness.json`) links into `<config_root>/harnesses/<id>`
//!   — pure data the frontend composes (A5); nothing here mints a token.
//! - a **code extension** (`extension.json`) links into the extensions root,
//!   then hot-loads through the same arm the marketplace install uses
//!   (`load_extension_dir` → `boot_token` → `load_one`). This is also how
//!   the docx codec (Track C, `external` tier) is installed.
//!
//! The safety rule this module exists to enforce: **we may only ever create
//! and remove links; a real directory is never replaced and never deleted.**
//! A real dir under the root is either a marketplace install or the user's
//! hand-authored work — both have owners, and neither is ours to clobber.

use std::path::{Path, PathBuf};

/// What kind of installable a folder holds — decided by its manifest file,
/// nothing else. A folder claiming to be both is confused, and an install
/// must not guess which identity was meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderKind {
    Harness,
    Extension,
}

pub fn detect(folder: &Path) -> Result<FolderKind, String> {
    let harness = folder.join("harness.json").is_file();
    let extension = folder.join("extension.json").is_file();
    match (harness, extension) {
        (true, true) => Err(
            "this folder holds both a harness.json and an extension.json — \
             a folder is one installable, split them"
                .to_string(),
        ),
        (true, false) => Ok(FolderKind::Harness),
        (false, true) => Ok(FolderKind::Extension),
        (false, false) => Err(
            "no harness.json or extension.json here — pick the folder that \
             holds the manifest"
                .to_string(),
        ),
    }
}

/// The identity a harness folder installs under, read from its manifest.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct HarnessInstall {
    pub id: String,
    pub name: String,
}

/// Parse just enough of a harness manifest to install it: an object with a
/// non-empty `id` and `name`. Install is an explicit act, so unlike the
/// boot scan this is hard-error with the reason — the lenient-skip posture
/// belongs to reads the user never asked for.
pub fn read_harness_identity(folder: &Path) -> Result<HarnessInstall, String> {
    let path = folder.join("harness.json");
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.len() > crate::userconfig::MAX_HARNESS_BYTES {
        return Err(format!(
            "harness.json is {} bytes — the cap is {}",
            meta.len(),
            crate::userconfig::MAX_HARNESS_BYTES
        ));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("unparseable harness.json: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or("harness.json must be a JSON object")?;
    let id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("harness.json needs a non-empty string `id`")?;
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("harness.json needs a non-empty string `name`")?;
    // The id becomes the link's directory name, so it carries the same
    // grammar the extension name/dir rule uses — path hygiene by identity.
    if !crate::extension::valid_name(id) {
        return Err(format!(
            "harness id {id:?} must be 1-32 chars of a-z 0-9 _ - (it names the install directory)"
        ));
    }
    Ok(HarnessInstall {
        id: id.to_string(),
        name: name.to_string(),
    })
}

fn symlink_dir(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(target, link);
    made.map_err(|e| format!("couldn't link {}: {e}", link.display()))
}

/// Place (or retarget) the `<parent>/<name>` link at `folder`. The one
/// mutation primitive every install here shares — and the one place the
/// never-clobber-a-real-directory rule lives.
fn place_link(parent: &Path, name: &str, folder: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let dest = parent.join(name);
    match std::fs::symlink_metadata(&dest) {
        Ok(meta) if meta.file_type().is_symlink() => {
            // Re-linking is the loop: same name, possibly a moved folder.
            std::fs::remove_file(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        }
        Ok(_) => {
            return Err(format!(
                "{name:?} is already installed as a real directory at {} — it was not \
                 link-installed, so it is not ours to replace; remove it first",
                dest.display()
            ));
        }
        Err(_) => {}
    }
    symlink_dir(folder, &dest)?;
    Ok(dest)
}

/// Canonicalize and sanity-check the folder being installed. Canonical so
/// the link survives the picker handing back a path with `..` or a symlink
/// of its own, and so a later `read_link` shows the user a real place.
fn canonical_folder(folder: &Path) -> Result<PathBuf, String> {
    let folder = std::fs::canonicalize(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    if !folder.is_dir() {
        return Err(format!("{} is not a directory", folder.display()));
    }
    Ok(folder)
}

/// Link-install a harness pack: `<config_root>/harnesses/<id>` → `folder`.
/// `list_harnesses` re-reads through the link on every scan, so from here
/// on the author's edits are live by construction.
pub fn install_harness_folder(
    config_root: &Path,
    folder: &Path,
) -> Result<HarnessInstall, String> {
    let folder = canonical_folder(folder)?;
    let identity = read_harness_identity(&folder)?;
    place_link(&config_root.join("harnesses"), &identity.id, &folder)?;
    Ok(identity)
}

/// Remove a link-installed harness. Guarded to links: a real directory
/// under `harnesses/` is hand-authored work — name where it lives instead
/// of deleting it.
pub fn uninstall_harness_link(config_root: &Path, id: &str) -> Result<(), String> {
    if !crate::extension::valid_name(id) {
        return Err(format!("invalid harness id {id:?}"));
    }
    let dest = config_root.join("harnesses").join(id);
    match std::fs::symlink_metadata(&dest) {
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::remove_file(&dest).map_err(|e| format!("{}: {e}", dest.display()))
        }
        Ok(_) => Err(format!(
            "{id:?} is hand-authored at {} — not link-installed, delete it yourself if you \
             mean to",
            dest.display()
        )),
        Err(_) => Err(format!("no harness {id:?} is installed")),
    }
}

/// Link a code extension's folder into the extensions root under `name`
/// (already validated against the folder's manifest by the caller). The
/// caller then loads *through the link*, so the manifest's name==dir rule
/// holds at the installed path and `.token` (external kind) lands in the
/// author's own folder — where their process expects to read it.
pub fn link_extension_folder(
    extensions_root: &Path,
    folder: &Path,
    name: &str,
) -> Result<PathBuf, String> {
    let folder = canonical_folder(folder)?;
    place_link(extensions_root, name, &folder)
}

/// Where a link-installed entry actually lives, for provenance display.
pub fn link_target(dir: &Path) -> Option<String> {
    std::fs::read_link(dir)
        .ok()
        .map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("redline-localinstall-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn harness_folder(root: &Path, id: &str) -> PathBuf {
        let dir = root.join(format!("proj-{id}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("harness.json"),
            format!(r#"{{"id":"{id}","name":"The {id}","workspace":{{}}}}"#),
        )
        .unwrap();
        dir
    }

    #[test]
    fn detect_names_the_manifest_or_the_confusion() {
        let root = tmp();
        let none = root.join("plain");
        std::fs::create_dir_all(&none).unwrap();
        assert!(detect(&none).is_err());

        let h = harness_folder(&root, "desk");
        assert_eq!(detect(&h).unwrap(), FolderKind::Harness);

        let e = root.join("ext");
        std::fs::create_dir_all(&e).unwrap();
        std::fs::write(e.join("extension.json"), "{}").unwrap();
        assert_eq!(detect(&e).unwrap(), FolderKind::Extension);

        std::fs::write(h.join("extension.json"), "{}").unwrap();
        assert!(detect(&h).unwrap_err().contains("both"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn harness_identity_is_validated_hard() {
        let root = tmp();
        let dir = root.join("bad");
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join("harness.json"), "not json").unwrap();
        assert!(read_harness_identity(&dir).unwrap_err().contains("unparseable"));

        std::fs::write(dir.join("harness.json"), r#"{"name":"x"}"#).unwrap();
        assert!(read_harness_identity(&dir).unwrap_err().contains("`id`"));

        std::fs::write(dir.join("harness.json"), r#"{"id":"Bad Id","name":"x"}"#).unwrap();
        assert!(read_harness_identity(&dir).unwrap_err().contains("1-32 chars"));

        std::fs::write(dir.join("harness.json"), r#"{"id":"ok","name":"  "}"#).unwrap();
        assert!(read_harness_identity(&dir).unwrap_err().contains("`name`"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_links_and_edits_are_live_through_the_link() {
        let root = tmp();
        let cfg = root.join("cfg");
        let proj = harness_folder(&root, "desk");
        let installed = install_harness_folder(&cfg, &proj).unwrap();
        assert_eq!(installed.id, "desk");

        let link = cfg.join("harnesses").join("desk");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        // The scan-side read goes through the link…
        let listed = crate::userconfig::list_harnesses_under(&cfg);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].json.contains("The desk"));
        // …so an edit in the PROJECT is live on the next read, no re-install.
        std::fs::write(
            proj.join("harness.json"),
            r#"{"id":"desk","name":"Renamed desk"}"#,
        )
        .unwrap();
        let listed = crate::userconfig::list_harnesses_under(&cfg);
        assert!(listed[0].json.contains("Renamed desk"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reinstall_retargets_but_a_real_directory_is_never_replaced() {
        let root = tmp();
        let cfg = root.join("cfg");
        let a = harness_folder(&root, "desk");
        install_harness_folder(&cfg, &a).unwrap();

        // Same id from a moved/second folder: the link retargets.
        let b = root.join("proj-desk-v2");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("harness.json"), r#"{"id":"desk","name":"Desk v2"}"#).unwrap();
        install_harness_folder(&cfg, &b).unwrap();
        let listed = crate::userconfig::list_harnesses_under(&cfg);
        assert!(listed[0].json.contains("Desk v2"));

        // A REAL directory under harnesses/ belongs to someone: refuse.
        let real = cfg.join("harnesses").join("hand");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("harness.json"), r#"{"id":"hand","name":"Hand"}"#).unwrap();
        let c = harness_folder(&root, "hand");
        let err = install_harness_folder(&cfg, &c).unwrap_err();
        assert!(err.contains("real directory"), "{err}");
        assert!(real.join("harness.json").is_file(), "the real dir must survive");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstall_removes_only_the_link_never_the_project() {
        let root = tmp();
        let cfg = root.join("cfg");
        let proj = harness_folder(&root, "desk");
        install_harness_folder(&cfg, &proj).unwrap();

        uninstall_harness_link(&cfg, "desk").unwrap();
        assert!(std::fs::symlink_metadata(cfg.join("harnesses").join("desk")).is_err());
        // The author's folder — and their manifest — are untouched.
        assert!(proj.join("harness.json").is_file());

        // Guards: absent, and hand-authored (a real dir).
        assert!(uninstall_harness_link(&cfg, "desk").unwrap_err().contains("no harness"));
        let real = cfg.join("harnesses").join("hand");
        std::fs::create_dir_all(&real).unwrap();
        let err = uninstall_harness_link(&cfg, "hand").unwrap_err();
        assert!(err.contains("hand-authored"), "{err}");
        assert!(real.is_dir(), "a real dir is named, never deleted");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extension_link_shares_the_never_clobber_rule() {
        let root = tmp();
        let ext_root = root.join("extensions");
        let proj = root.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("extension.json"), "{}").unwrap();

        let dest = link_extension_folder(&ext_root, &proj, "mine").unwrap();
        assert!(std::fs::symlink_metadata(&dest).unwrap().file_type().is_symlink());
        assert_eq!(
            link_target(&dest).unwrap(),
            std::fs::canonicalize(&proj).unwrap().display().to_string()
        );

        let real = ext_root.join("curated");
        std::fs::create_dir_all(&real).unwrap();
        assert!(link_extension_folder(&ext_root, &proj, "curated")
            .unwrap_err()
            .contains("real directory"));
        assert!(real.is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }
}

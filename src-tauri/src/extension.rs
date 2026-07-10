//! Plugin manifest v1 (Shardplate Phase 2, declarative only): an
//! "extension" is an external local process that talks to the daemon's
//! `/v1` contract with a token scoped to the routes it declared. No
//! in-process UI plugins — that's marketplace territory and stays parked.
//!
//! Layout: `~/.redline/extensions/<name>/extension.json`
//!
//! ```json
//! {
//!   "name": "my-linter",
//!   "version": "0.1",
//!   "scopes": ["review.annotate"],
//!   "entry": "my-linter --watch"
//! }
//! ```
//!
//! At every Redline launch, each valid manifest gets a fresh random token
//! written to `<dir>/.token` (owner-only mode) and registered with the
//! auth middleware for exactly the declared scopes. Per-boot rotation is
//! deliberate: revoking an extension is "delete its folder and relaunch",
//! and a leaked token dies with the process that minted it. The extension
//! reads its token file at startup and sends
//! `Authorization: Bearer <token>` on scoped calls.
//!
//! Validation is skip-with-warning, never fail-the-boot: a bad manifest
//! (unparseable JSON, bad name, unknown scope) is logged and ignored, the
//! same posture as user themes and user skills from Phase 1.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::auth;

/// The declarative manifest. Unknown fields are tolerated (a newer
/// manifest should degrade, not break, under an older Redline); `entry`
/// is advisory metadata in v1 — Redline does not launch extensions.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtensionManifest {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub entry: Option<String>,
}

/// A manifest that survived validation, plus where it lives (the token
/// file is written next to it).
#[derive(Debug, Clone)]
pub struct LoadedExtension {
    pub manifest: ExtensionManifest,
    pub dir: PathBuf,
}

/// Same shape rule as external-annotation source tags: 1–32 chars of
/// lowercase/digit/`_`/`-`. The name is also the directory name, so this
/// doubles as path hygiene.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Why a manifest was rejected — carried in the warning log so the author
/// can fix it without spelunking.
fn validate(manifest: &ExtensionManifest, dir_name: &str) -> Result<(), String> {
    if !valid_name(&manifest.name) {
        return Err(format!(
            "invalid name {:?} (1-32 chars of a-z 0-9 _ -)",
            manifest.name
        ));
    }
    if manifest.name != dir_name {
        return Err(format!(
            "name {:?} must match its directory name {dir_name:?}",
            manifest.name
        ));
    }
    if manifest.scopes.is_empty() {
        return Err("declares no scopes — a token with no scope can call nothing".to_string());
    }
    for scope in &manifest.scopes {
        if !auth::KNOWN_SCOPES.contains(&scope.as_str()) {
            return Err(format!(
                "unknown scope {scope:?} (known: {})",
                auth::KNOWN_SCOPES.join(", ")
            ));
        }
    }
    Ok(())
}

/// Scan an extensions root for valid manifests. Pure-ish (parameterized on
/// the root) so tests drive it against a temp dir; invalid entries warn and
/// are skipped.
pub fn load_extensions(root: &Path) -> Vec<LoadedExtension> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut loaded = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("extension.json");
        let Ok(raw) = fs::read_to_string(&manifest_path) else {
            continue; // not an extension dir; stay quiet
        };
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let manifest: ExtensionManifest = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("extension {dir_name}: unparseable extension.json: {e}");
                continue;
            }
        };
        if let Err(why) = validate(&manifest, &dir_name) {
            tracing::warn!("extension {dir_name}: {why} — skipped");
            continue;
        }
        loaded.push(LoadedExtension { manifest, dir });
    }
    loaded.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    loaded
}

/// Default extensions root, alongside Phase 1's `~/.redline/themes` and
/// `~/.redline/skills`.
pub fn extensions_root() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".redline").join("extensions"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Mint and place per-boot scoped tokens for every valid manifest under
/// `root`, registering each with the auth middleware. Returns the loaded
/// extensions for the startup log. Token files are owner-only (0600): the
/// boundary is "processes that can already read your home dir", the same
/// boundary the lake itself lives behind.
pub fn install_boot_tokens(root: &Path) -> Vec<LoadedExtension> {
    let loaded = load_extensions(root);
    for ext in &loaded {
        let token = auth::mint_extension_token();
        let token_path = ext.dir.join(".token");
        if let Err(e) = fs::write(&token_path, &token) {
            tracing::warn!(
                "extension {}: could not write {}: {e} — token not issued",
                ext.manifest.name,
                token_path.display()
            );
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600));
        }
        auth::register_grant(
            token,
            auth::ExtensionGrant {
                name: ext.manifest.name.clone(),
                scopes: ext.manifest.scopes.clone(),
            },
        );
        tracing::info!(
            "extension {}: issued token for scopes [{}]",
            ext.manifest.name,
            ext.manifest.scopes.join(", ")
        );
    }
    loaded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("redline-extension-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_manifest(root: &Path, name: &str, json: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("extension.json"), json).unwrap();
        dir
    }

    #[test]
    fn loads_valid_manifest_and_skips_invalid() {
        let root = temp_root();
        write_manifest(
            &root,
            "my-linter",
            r#"{"name":"my-linter","scopes":["review.annotate"],"entry":"my-linter --watch"}"#,
        );
        // Unknown scope → skipped.
        write_manifest(&root, "greedy", r#"{"name":"greedy","scopes":["root.everything"]}"#);
        // Name/dir mismatch → skipped.
        write_manifest(
            &root,
            "dir-name",
            r#"{"name":"other-name","scopes":["review.annotate"]}"#,
        );
        // No scopes → skipped.
        write_manifest(&root, "scopeless", r#"{"name":"scopeless"}"#);
        // Bad JSON → skipped.
        write_manifest(&root, "broken", "{nope");
        // Unknown fields tolerated.
        write_manifest(
            &root,
            "tolerant",
            r#"{"name":"tolerant","scopes":["drafter.suggest"],"future_field":true}"#,
        );

        let loaded = load_extensions(&root);
        let names: Vec<&str> = loaded.iter().map(|e| e.manifest.name.as_str()).collect();
        assert_eq!(names, vec!["my-linter", "tolerant"]);
        assert_eq!(loaded[0].manifest.entry.as_deref(), Some("my-linter --watch"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_root_loads_nothing() {
        let root = temp_root();
        assert!(load_extensions(&root.join("nope")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn boot_tokens_are_written_owner_only_and_scoped() {
        let _guard = auth::grants_test_lock();
        let root = temp_root();
        let dir = write_manifest(
            &root,
            "annotator",
            r#"{"name":"annotator","scopes":["review.annotate"]}"#,
        );
        auth::clear_grants_for_test();
        let loaded = install_boot_tokens(&root);
        assert_eq!(loaded.len(), 1);

        let token = fs::read_to_string(dir.join(".token")).unwrap();
        assert_eq!(token.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(".token")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // The written token authorizes exactly its scope, nothing else.
        assert_eq!(
            auth::authorize("/v1/reviews/annotations", "POST", Some(&token)),
            Ok(())
        );
        assert!(auth::authorize("/v1/browser/navigate", "POST", Some(&token)).is_err());
        auth::clear_grants_for_test();
        let _ = fs::remove_dir_all(&root);
    }
}

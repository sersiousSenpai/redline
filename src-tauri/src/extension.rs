//! Plugin manifest (Shardplate Phase 2 → Elevation B3): an "extension" is
//! either an **external local process** (`kind: "external"`, v1's only
//! shape) talking to the daemon's `/v1` contract with a scoped token, or an
//! **in-process WASM module** (`kind: "wasm"`, manifest v2) run by
//! `extension_host.rs` with the *same* scoped token driven through the
//! *same* router. Phase 2's "no in-process plugins" parking note is hereby
//! un-parked (owner-approved, Elevation program B3); external-process
//! extensions remain supported forever as the escape hatch for
//! compute-heavy work.
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
//! …or, manifest v2's wasm shape (`module` is a bare filename next to the
//! manifest; `events` come from the closed `KNOWN_EVENTS` vocabulary in
//! `redline-extension-abi`):
//!
//! ```json
//! {
//!   "name": "greeter",
//!   "kind": "wasm",
//!   "module": "extension.wasm",
//!   "api_version": 1,
//!   "scopes": ["plan.comment"],
//!   "events": ["plan.received"]
//! }
//! ```
//!
//! At every Redline launch, each valid manifest gets a fresh random token
//! registered with the auth middleware for exactly the declared scopes.
//! For external extensions the token is written to `<dir>/.token`
//! (owner-only mode) for the process to read; for wasm extensions it is
//! handed to the host **in memory only** — it never touches disk or guest
//! memory. Per-boot rotation is deliberate: revoking an extension is
//! "delete its folder and relaunch", and a leaked token dies with the
//! process that minted it.
//!
//! Validation is skip-with-warning, never fail-the-boot: a bad manifest
//! (unparseable JSON, bad name, unknown scope, unknown event, wrong
//! api_version, module path games) is logged and ignored, the same posture
//! as user themes and user skills from Phase 1.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::auth;

/// Manifest `kind` values — the closed set.
pub const KIND_EXTERNAL: &str = "external";
pub const KIND_WASM: &str = "wasm";

/// The declarative manifest. Unknown fields are tolerated (a newer
/// manifest should degrade, not break, under an older Redline); `entry`
/// is advisory metadata — Redline does not launch external extensions.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtensionManifest {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub entry: Option<String>,
    /// v2: `"external"` (default — full v1 back-compat) or `"wasm"`.
    #[serde(default)]
    pub kind: Option<String>,
    /// v2, wasm only: the module's bare filename next to the manifest.
    #[serde(default)]
    pub module: Option<String>,
    /// v2, wasm only: must equal `redline_extension_abi::API_VERSION`.
    #[serde(default)]
    pub api_version: Option<u32>,
    /// v2, wasm only: subscriptions ⊆ the closed `KNOWN_EVENTS` vocabulary.
    #[serde(default)]
    pub events: Vec<String>,
}

impl ExtensionManifest {
    pub fn kind(&self) -> &str {
        self.kind.as_deref().unwrap_or(KIND_EXTERNAL)
    }

    pub fn is_wasm(&self) -> bool {
        self.kind() == KIND_WASM
    }
}

/// A manifest that survived validation, plus where it lives (the token
/// file is written next to it).
#[derive(Debug, Clone)]
pub struct LoadedExtension {
    pub manifest: ExtensionManifest,
    pub dir: PathBuf,
}

impl LoadedExtension {
    /// Absolute path of a wasm extension's module file.
    pub fn module_path(&self) -> Option<PathBuf> {
        if !self.manifest.is_wasm() {
            return None;
        }
        Some(self.dir.join(self.manifest.module.as_deref()?))
    }
}

/// Same shape rule as external-annotation source tags: 1–32 chars of
/// lowercase/digit/`_`/`-`. The name is also the directory name, so this
/// doubles as path hygiene. Shared with the marketplace's index validation
/// (`marketplace.rs`) so an index entry that validates also installs.
pub(crate) fn valid_name(name: &str) -> bool {
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
    match manifest.kind() {
        KIND_EXTERNAL => {
            if !manifest.events.is_empty() {
                return Err(
                    "declares events, but only kind \"wasm\" receives event deliveries"
                        .to_string(),
                );
            }
        }
        KIND_WASM => {
            let Some(module) = manifest.module.as_deref() else {
                return Err("kind \"wasm\" requires a `module` filename".to_string());
            };
            // Bare filename only: the module must live next to its manifest.
            // Same path-hygiene stance as the name/dir rule above.
            if module.is_empty()
                || module.contains('/')
                || module.contains('\\')
                || module.contains("..")
            {
                return Err(format!(
                    "module {module:?} must be a bare filename next to extension.json"
                ));
            }
            match manifest.api_version {
                Some(v) if v == redline_extension_abi::API_VERSION => {}
                Some(v) => {
                    return Err(format!(
                        "api_version {v} not supported (host speaks {})",
                        redline_extension_abi::API_VERSION
                    ));
                }
                None => {
                    return Err("kind \"wasm\" requires `api_version`".to_string());
                }
            }
            for event in &manifest.events {
                if !redline_extension_abi::events::KNOWN_EVENTS.contains(&event.as_str()) {
                    return Err(format!(
                        "unknown event {event:?} (known: {})",
                        redline_extension_abi::events::KNOWN_EVENTS.join(", ")
                    ));
                }
            }
        }
        other => {
            return Err(format!(
                "unknown kind {other:?} (known: {KIND_EXTERNAL}, {KIND_WASM})"
            ));
        }
    }
    Ok(())
}

/// Load and validate the manifest in one extension directory. `Err` carries
/// why — the boot scan treats that as a warning, B4's marketplace
/// hot-install as a hard error.
pub fn load_extension_dir(dir: &Path) -> Result<LoadedExtension, String> {
    let manifest = read_manifest(dir)?;
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "extension dir has no name".to_string())?;
    validate(&manifest, &dir_name)?;
    Ok(LoadedExtension {
        manifest,
        dir: dir.to_path_buf(),
    })
}

/// Validate an extension SOURCE folder for local install (A5a). Everything
/// `load_extension_dir` checks except the name==dir coupling: the author's
/// project folder may be named anything, because the install links it under
/// `manifest.name` — after which the coupling holds at the installed path
/// and every later load goes through `load_extension_dir` as usual.
pub fn load_extension_folder(dir: &Path) -> Result<ExtensionManifest, String> {
    let manifest = read_manifest(dir)?;
    let name = manifest.name.clone();
    validate(&manifest, &name)?;
    Ok(manifest)
}

fn read_manifest(dir: &Path) -> Result<ExtensionManifest, String> {
    let manifest_path = dir.join("extension.json");
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("{}: {e}", manifest_path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("unparseable extension.json: {e}"))
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
        if !dir.is_dir() || !dir.join("extension.json").is_file() {
            continue; // not an extension dir; stay quiet
        }
        match load_extension_dir(&dir) {
            Ok(ext) => loaded.push(ext),
            Err(why) => {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                tracing::warn!("extension {dir_name}: {why} — skipped");
            }
        }
    }
    loaded.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    loaded
}

/// Default extensions root, alongside Phase 1's `~/.redline/themes` and
/// `~/.redline/skills`. Routed through the flavor-aware config root so a
/// flavored build (REDLINE_HARNESS baked) keeps its extensions under its own
/// `~/.redline/flavors/<id>/` — for the default build this is byte-identical
/// to the old `~/.redline/extensions`.
pub fn extensions_root() -> Option<PathBuf> {
    dirs_home().map(|_| crate::userconfig::config_root().join("extensions"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// One extension with its per-boot token minted and registered. For
/// external extensions the token was also written to `<dir>/.token`; for
/// wasm extensions it exists only here, so the host can attach it to
/// `host_call` requests without it ever touching disk or guest memory.
#[derive(Debug, Clone)]
pub struct BootedExtension {
    pub ext: LoadedExtension,
    pub token: String,
}

/// Mint and register the scoped token for one loaded extension — the shared
/// arm of the boot scan and B4's marketplace hot-install. External
/// extensions get theirs written to `<dir>/.token`, owner-only (0600): the
/// boundary is "processes that can already read your home dir", the same
/// boundary the lake itself lives behind. Wasm extensions get theirs in
/// memory only (any stale `.token` from a previously-external manifest is
/// removed).
pub fn boot_token(ext: LoadedExtension) -> Result<BootedExtension, String> {
    let token = auth::mint_extension_token();
    let token_path = ext.dir.join(".token");
    if ext.manifest.is_wasm() {
        let _ = fs::remove_file(&token_path);
    } else {
        fs::write(&token_path, &token).map_err(|e| {
            format!("could not write {}: {e} — token not issued", token_path.display())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600));
        }
    }
    auth::register_grant(
        token.clone(),
        auth::ExtensionGrant {
            name: ext.manifest.name.clone(),
            scopes: ext.manifest.scopes.clone(),
        },
    );
    tracing::info!(
        "extension {} ({}): issued token for scopes [{}]",
        ext.manifest.name,
        ext.manifest.kind(),
        ext.manifest.scopes.join(", ")
    );
    Ok(BootedExtension { ext, token })
}

/// Mint and register per-boot scoped tokens for every valid manifest under
/// `root` (skip-with-warning, like the manifest scan itself).
pub fn install_boot_tokens(root: &Path) -> Vec<BootedExtension> {
    let loaded = load_extensions(root);
    let mut booted = Vec::new();
    for ext in loaded {
        let name = ext.manifest.name.clone();
        match boot_token(ext) {
            Ok(b) => booted.push(b),
            Err(why) => tracing::warn!("extension {name}: {why}"),
        }
    }
    booted
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

    /// Manifest v2 validation matrix: the wasm shape loads; path games,
    /// version mismatches, unknown events/kinds, and events-on-external all
    /// skip-with-warning; v1 manifests are untouched by the new rules.
    #[test]
    fn manifest_v2_validation_matrix() {
        let root = temp_root();
        write_manifest(
            &root,
            "wasm-ok",
            r#"{"name":"wasm-ok","kind":"wasm","module":"extension.wasm","api_version":1,"scopes":["plan.comment"],"events":["plan.received"]}"#,
        );
        // Module path traversal → skipped.
        write_manifest(
            &root,
            "traversal",
            r#"{"name":"traversal","kind":"wasm","module":"../evil.wasm","api_version":1,"scopes":["plan.comment"]}"#,
        );
        // Wrong / missing api_version → skipped.
        write_manifest(
            &root,
            "future",
            r#"{"name":"future","kind":"wasm","module":"m.wasm","api_version":2,"scopes":["plan.comment"]}"#,
        );
        write_manifest(
            &root,
            "unversioned",
            r#"{"name":"unversioned","kind":"wasm","module":"m.wasm","scopes":["plan.comment"]}"#,
        );
        // Unknown event → skipped.
        write_manifest(
            &root,
            "badevent",
            r#"{"name":"badevent","kind":"wasm","module":"m.wasm","api_version":1,"scopes":["plan.comment"],"events":["plan.exploded"]}"#,
        );
        // Missing module → skipped.
        write_manifest(
            &root,
            "moduleless",
            r#"{"name":"moduleless","kind":"wasm","api_version":1,"scopes":["plan.comment"]}"#,
        );
        // Unknown kind → skipped.
        write_manifest(
            &root,
            "exotic",
            r#"{"name":"exotic","kind":"native","scopes":["plan.comment"]}"#,
        );
        // Events on an external extension → skipped (only wasm receives them).
        write_manifest(
            &root,
            "ext-events",
            r#"{"name":"ext-events","scopes":["plan.comment"],"events":["plan.received"]}"#,
        );
        // A v1 manifest stays valid, byte for byte.
        write_manifest(
            &root,
            "v1-classic",
            r#"{"name":"v1-classic","scopes":["review.annotate"],"entry":"linter --watch"}"#,
        );

        let loaded = load_extensions(&root);
        let names: Vec<&str> = loaded.iter().map(|e| e.manifest.name.as_str()).collect();
        assert_eq!(names, vec!["v1-classic", "wasm-ok"]);
        let wasm = &loaded[1];
        assert!(wasm.manifest.is_wasm());
        assert_eq!(
            wasm.module_path().unwrap(),
            root.join("wasm-ok").join("extension.wasm")
        );
        assert!(!loaded[0].manifest.is_wasm());
        assert_eq!(loaded[0].module_path(), None);
        let _ = fs::remove_dir_all(&root);
    }

    /// A wasm extension's token is registered but never written to disk —
    /// and a stale `.token` from a previously-external manifest is removed.
    #[test]
    fn wasm_boot_token_stays_off_disk() {
        let _guard = auth::grants_test_lock();
        let root = temp_root();
        let dir = write_manifest(
            &root,
            "observer",
            r#"{"name":"observer","kind":"wasm","module":"m.wasm","api_version":1,"scopes":["plan.comment"],"events":["plan.received"]}"#,
        );
        fs::write(dir.join(".token"), "stale-from-external-days").unwrap();
        auth::clear_grants_for_test();
        let booted = install_boot_tokens(&root);
        assert_eq!(booted.len(), 1);
        assert!(!dir.join(".token").exists(), "wasm token must not touch disk");
        assert_eq!(booted[0].token.len(), 64);
        // The in-memory token authorizes exactly its scope.
        assert_eq!(
            authorize_comment(&booted[0].token),
            Ok(()),
            "granted scope must authorize"
        );
        assert!(
            auth::authorize("/v1/browser/navigate", "POST", Some(&booted[0].token)).is_err()
        );
        auth::clear_grants_for_test();
        let _ = fs::remove_dir_all(&root);
    }

    fn authorize_comment(token: &str) -> Result<(), auth::Denial> {
        auth::authorize(
            "/v1/sessions/:session_id/comments",
            "POST",
            Some(token),
        )
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

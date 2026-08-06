//! Extension marketplace (Elevation B4): fetch a curated index, verify an
//! artifact against the entry the user consented to, install it under
//! `~/.redline/extensions/<name>/`, and hand it to `extension_host` for
//! hot-registration — no relaunch.
//!
//! **Trust model (v1):** human PR review on the `redline-extensions` index
//! repo is the trust root — the index is curated, its CI re-verifies every
//! artifact hash/size/schema, and this module re-verifies all of it again at
//! install (sha256, exact size, wasm magic, manifest generated *from the
//! index entry* so there is no artifact/manifest mismatch class). Artifact
//! minisign signatures are named as v2.
//!
//! **Local-only posture:** Redline never fetches the index on its own until
//! the user has opened the marketplace once (the launch update-check runs
//! only when a cached index already exists — see `docs/local-only-audit.md`
//! and `docs/marketplace.md`). Artifacts download only on an explicit,
//! consented install. Updates are never automatic.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::extension;

/// Schema id the index file must carry (`redline.extension-index/1`).
pub const INDEX_SCHEMA: &str = "redline.extension-index/1";

/// Canonical index location — the curated `redline-extensions` repo (its
/// staging tree lives under `marketplace/` in this repo until the public
/// launch, which follows the first signed DMG). Until the repo goes public
/// this URL 404s; the UI shows that as "index unavailable", never an error
/// wall.
pub const INDEX_URL: &str =
    "https://raw.githubusercontent.com/sersiousSenpai/redline-extensions/main/index.json";

/// Env override for development and e2e (a local index server). Honored
/// only for https or loopback URLs.
pub const ENV_INDEX_URL: &str = "REDLINE_EXTENSIONS_INDEX_URL";

/// Artifact ceiling — mirrored in the index repo's CI (`validate.mjs`); a
/// drift test below pins the mirror. Deliberately half the host's 10 MB
/// module cap so an index-valid artifact can never be host-rejected.
pub const ARTIFACT_CAP_BYTES: u64 = 5 * 1024 * 1024;

/// This build's version, for `min_redline` gating.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// Index schema.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexFile {
    pub schema: String,
    pub extensions: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexArtifact {
    /// Raw `.wasm` release asset on the extension's own repo.
    pub url: String,
    /// Lowercase hex sha256 of the artifact bytes.
    pub sha256: String,
    /// Exact artifact size in bytes.
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexEntry {
    pub name: String,
    /// Strict `major.minor.patch`.
    pub version: String,
    pub publisher: String,
    /// The extension's own repo (https), for the consent dialog's link.
    pub repo: String,
    pub artifact: IndexArtifact,
    pub scopes: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    pub api_version: u32,
    /// SPDX id; the allowlist (mirrored from `deny.toml`) gates in index CI.
    pub license: String,
    /// Minimum Redline version this extension needs.
    pub min_redline: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Changelog link surfaced on update re-consent.
    #[serde(default)]
    pub changelog: Option<String>,
}

/// Strict numeric `major.minor.patch` — the only version shape the index
/// accepts (pre-release/build tags would make "update available" ambiguous).
pub fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.split('.');
    let (a, b, c) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let num = |s: &str| -> Option<u64> {
        if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || s.len() > 9 {
            return None;
        }
        s.parse().ok()
    };
    Some((num(a)?, num(b)?, num(c)?))
}

/// Whether `candidate` is a strictly newer version than `installed`.
pub fn semver_newer(candidate: &str, installed: &str) -> bool {
    match (parse_semver(candidate), parse_semver(installed)) {
        (Some(c), Some(i)) => c > i,
        _ => false,
    }
}

/// Whether this Redline satisfies an entry's `min_redline`.
pub fn min_redline_ok(min: &str) -> bool {
    match (parse_semver(APP_VERSION), parse_semver(min)) {
        (Some(app), Some(min)) => app >= min,
        _ => false,
    }
}

fn sha256_shaped(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// https for the curated world; loopback http tolerated so a local index
/// server can drive dev and the e2e matrix.
fn url_allowed(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
}

/// Why an index entry was rejected — the skip-with-warning reason.
fn validate_entry(e: &IndexEntry) -> Result<(), String> {
    if !extension::valid_name(&e.name) {
        return Err(format!("invalid name {:?} (1-32 chars of a-z 0-9 _ -)", e.name));
    }
    if parse_semver(&e.version).is_none() {
        return Err(format!("version {:?} is not strict major.minor.patch", e.version));
    }
    if parse_semver(&e.min_redline).is_none() {
        return Err(format!(
            "min_redline {:?} is not strict major.minor.patch",
            e.min_redline
        ));
    }
    if e.api_version != redline_extension_abi::API_VERSION {
        return Err(format!(
            "api_version {} not supported (host speaks {})",
            e.api_version,
            redline_extension_abi::API_VERSION
        ));
    }
    if e.scopes.is_empty() {
        return Err("declares no scopes".to_string());
    }
    for scope in &e.scopes {
        if !redline_extension_abi::scopes::KNOWN_SCOPES.contains(&scope.as_str()) {
            return Err(format!("unknown scope {scope:?}"));
        }
    }
    for event in &e.events {
        if !redline_extension_abi::events::KNOWN_EVENTS.contains(&event.as_str()) {
            return Err(format!("unknown event {event:?}"));
        }
    }
    if !url_allowed(&e.artifact.url) {
        return Err(format!("artifact url {:?} must be https", e.artifact.url));
    }
    if !url_allowed(&e.repo) {
        return Err(format!("repo url {:?} must be https", e.repo));
    }
    if !sha256_shaped(&e.artifact.sha256) {
        return Err("artifact sha256 must be 64 lowercase hex chars".to_string());
    }
    if e.artifact.size == 0 || e.artifact.size > ARTIFACT_CAP_BYTES {
        return Err(format!(
            "artifact size {} outside (0, {} MB]",
            e.artifact.size,
            ARTIFACT_CAP_BYTES / (1024 * 1024)
        ));
    }
    if e.license.trim().is_empty() {
        return Err("missing SPDX license".to_string());
    }
    Ok(())
}

/// Parse a raw index document. `Err` for an unusable document (bad JSON,
/// wrong schema id); otherwise the valid entries plus one warning per
/// skipped entry — the same skip-with-warning posture as manifest loading.
/// Duplicate names keep the first entry (the curated index CI refuses them;
/// this is defense in depth).
pub fn parse_index(raw: &str) -> Result<(Vec<IndexEntry>, Vec<String>), String> {
    let file: IndexFile =
        serde_json::from_str(raw).map_err(|e| format!("index unparseable: {e}"))?;
    if file.schema != INDEX_SCHEMA {
        return Err(format!(
            "index schema {:?} unsupported (expected {INDEX_SCHEMA:?})",
            file.schema
        ));
    }
    let mut entries: Vec<IndexEntry> = Vec::new();
    let mut warnings = Vec::new();
    for e in file.extensions {
        if let Err(why) = validate_entry(&e) {
            warnings.push(format!("index entry {:?}: {why} — skipped", e.name));
            continue;
        }
        if entries.iter().any(|prev| prev.name == e.name) {
            warnings.push(format!("index entry {:?}: duplicate name — skipped", e.name));
            continue;
        }
        entries.push(e);
    }
    Ok((entries, warnings))
}

// ---------------------------------------------------------------------------
// Fetch.

pub fn index_url() -> String {
    match std::env::var(ENV_INDEX_URL) {
        Ok(url) if url_allowed(&url) => url,
        Ok(url) => {
            tracing::warn!("{ENV_INDEX_URL}={url:?} ignored (https or loopback only)");
            INDEX_URL.to_string()
        }
        Err(_) => INDEX_URL.to_string(),
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(format!("redline-marketplace/{APP_VERSION}"))
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch the raw index document (metadata only — never artifacts).
pub async fn fetch_index() -> Result<String, String> {
    let url = index_url();
    let resp = http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("index fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("index fetch: {} from {url}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("index fetch: {e}"))
}

/// Download one artifact (explicit, consented install only). The byte-level
/// verification happens in [`verify_artifact`] regardless of what the
/// server sent.
pub async fn fetch_artifact(entry: &IndexEntry) -> Result<Vec<u8>, String> {
    if !url_allowed(&entry.artifact.url) {
        return Err("artifact url must be https".to_string());
    }
    let resp = http_client()?
        .get(&entry.artifact.url)
        .send()
        .await
        .map_err(|e| format!("artifact fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("artifact fetch: {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > ARTIFACT_CAP_BYTES {
            return Err(format!("artifact is {len} bytes — over the cap"));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("artifact fetch: {e}"))?;
    Ok(bytes.to_vec())
}

// ---------------------------------------------------------------------------
// Verify + install.

/// Byte-level verification against the entry the user consented to: exact
/// size, sha256, and the core-wasm magic. A mismatch refuses the install —
/// there is no "install anyway".
pub fn verify_artifact(entry: &IndexEntry, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != entry.artifact.size {
        return Err(format!(
            "artifact is {} bytes, index says {} — refusing install",
            bytes.len(),
            entry.artifact.size
        ));
    }
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if hex != entry.artifact.sha256 {
        return Err(format!(
            "artifact sha256 {hex} does not match the index's {} — refusing install",
            entry.artifact.sha256
        ));
    }
    if !bytes.starts_with(b"\0asm") {
        return Err("artifact is not a wasm module (bad magic) — refusing install".to_string());
    }
    Ok(())
}

/// The manifest is GENERATED from the index entry — the artifact never
/// carries its own, so there is no artifact/manifest mismatch class.
pub fn manifest_for(entry: &IndexEntry) -> String {
    let manifest = serde_json::json!({
        "name": entry.name,
        "version": entry.version,
        "kind": extension::KIND_WASM,
        "module": "extension.wasm",
        "api_version": entry.api_version,
        "scopes": entry.scopes,
        "events": entry.events,
    });
    serde_json::to_string_pretty(&manifest).expect("manifest serialize")
}

/// Write a verified install into `<root>/<name>/`: the module bytes plus
/// the generated manifest. Overwrites in place on update (the caller has
/// already dropped and revoked the old registration). Returns the dir.
pub fn write_install(entry: &IndexEntry, bytes: &[u8], root: &Path) -> Result<PathBuf, String> {
    verify_artifact(entry, bytes)?;
    if !extension::valid_name(&entry.name) {
        return Err(format!("invalid extension name {:?}", entry.name));
    }
    let dir = root.join(&entry.name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::write(dir.join("extension.wasm"), bytes)
        .map_err(|e| format!("write module: {e}"))?;
    std::fs::write(dir.join("extension.json"), manifest_for(entry))
        .map_err(|e| format!("write manifest: {e}"))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Enriched listing for the Browse tab + consent dialog.

/// One scope or event with its plain-language description — the consent
/// dialog's vocabulary rows. Descriptions come from the ABI crate, where a
/// test guarantees no scope goes undescribed.
#[derive(Debug, Clone, Serialize)]
pub struct DescribedName {
    pub name: String,
    pub description: String,
}

/// Install-state of an index entry relative to what's registered right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    Installable,
    Installed,
    UpdateAvailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketEntry {
    #[serde(flatten)]
    pub entry: IndexEntry,
    pub scope_details: Vec<DescribedName>,
    pub event_details: Vec<DescribedName>,
    pub min_redline_ok: bool,
    pub installed_version: Option<String>,
    pub state: InstallState,
}

/// Event purpose from the ABI's doc tables (the same rows
/// `docs/extensions-api.md` renders from).
pub fn describe_event(name: &str) -> Option<&'static str> {
    redline_extension_abi::docs::EVENT_DOCS
        .iter()
        .find(|d| d.name == name)
        .map(|d| d.purpose)
}

/// Join index entries with the live registry snapshot into what the Browse
/// tab renders. `installed` is `(name, version)` pairs.
pub fn enrich(
    entries: Vec<IndexEntry>,
    installed: &[(String, Option<String>)],
) -> Vec<MarketEntry> {
    entries
        .into_iter()
        .map(|entry| {
            let installed_version = installed
                .iter()
                .find(|(name, _)| *name == entry.name)
                .map(|(_, v)| v.clone().unwrap_or_default());
            let state = match &installed_version {
                None => InstallState::Installable,
                Some(v) if semver_newer(&entry.version, v) => InstallState::UpdateAvailable,
                Some(_) => InstallState::Installed,
            };
            let scope_details = entry
                .scopes
                .iter()
                .map(|s| DescribedName {
                    name: s.clone(),
                    description: redline_extension_abi::scopes::describe(s)
                        .unwrap_or("(undescribed)")
                        .to_string(),
                })
                .collect();
            let event_details = entry
                .events
                .iter()
                .map(|e| DescribedName {
                    name: e.clone(),
                    description: describe_event(e).unwrap_or("(undescribed)").to_string(),
                })
                .collect();
            MarketEntry {
                min_redline_ok: min_redline_ok(&entry.min_redline),
                installed_version,
                state,
                scope_details,
                event_details,
                entry,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, version: &str) -> IndexEntry {
        IndexEntry {
            name: name.to_string(),
            version: version.to_string(),
            publisher: "acme".to_string(),
            repo: "https://github.com/acme/ext".to_string(),
            artifact: IndexArtifact {
                url: "https://github.com/acme/ext/releases/download/v0.1.0/extension.wasm"
                    .to_string(),
                sha256: "a".repeat(64),
                size: 8,
            },
            scopes: vec!["plan.comment".to_string()],
            events: vec!["plan.received".to_string()],
            api_version: 1,
            license: "Apache-2.0".to_string(),
            min_redline: "0.1.0".to_string(),
            description: None,
            changelog: None,
        }
    }

    fn index_json(entries: &[IndexEntry]) -> String {
        serde_json::to_string(&IndexFile {
            schema: INDEX_SCHEMA.to_string(),
            extensions: entries.to_vec(),
        })
        .unwrap()
    }

    #[test]
    fn semver_parses_strictly() {
        assert_eq!(parse_semver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("0.1.0"), Some((0, 1, 0)));
        for bad in ["1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "01.2.3", "1..3", ""] {
            assert_eq!(parse_semver(bad), None, "{bad:?} must not parse");
        }
        assert!(semver_newer("0.2.0", "0.1.9"));
        assert!(semver_newer("1.0.0", "0.99.99"));
        assert!(!semver_newer("0.1.0", "0.1.0"));
        assert!(!semver_newer("0.1.0", "0.2.0"));
        assert!(!semver_newer("nope", "0.1.0"));
    }

    #[test]
    fn min_redline_gates_on_app_version() {
        assert!(min_redline_ok("0.0.1"));
        assert!(min_redline_ok(APP_VERSION));
        assert!(!min_redline_ok("999.0.0"));
        assert!(!min_redline_ok("not-a-version"));
    }

    /// Malformed entries skip-with-warning; the document survives.
    #[test]
    fn parse_index_skips_bad_entries_with_warnings() {
        let good = entry("good-ext", "0.1.0");
        let mut bad_scope = entry("bad-scope", "0.1.0");
        bad_scope.scopes = vec!["root.everything".to_string()];
        let mut bad_name = entry("BadName", "0.1.0");
        bad_name.name = "Bad Name!".to_string();
        let mut bad_url = entry("bad-url", "0.1.0");
        bad_url.artifact.url = "http://evil.example.com/x.wasm".to_string();
        let mut bad_size = entry("bad-size", "0.1.0");
        bad_size.artifact.size = ARTIFACT_CAP_BYTES + 1;
        let mut bad_api = entry("bad-api", "0.1.0");
        bad_api.api_version = 99;
        let mut bad_event = entry("bad-event", "0.1.0");
        bad_event.events = vec!["plan.exploded".to_string()];
        let dup = entry("good-ext", "0.9.9");

        let raw = index_json(&[
            good, bad_scope, bad_name, bad_url, bad_size, bad_api, bad_event, dup,
        ]);
        let (entries, warnings) = parse_index(&raw).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["good-ext"]
        );
        assert_eq!(entries[0].version, "0.1.0", "first entry wins on duplicate");
        assert_eq!(warnings.len(), 7);

        assert!(parse_index("{nope").is_err());
        assert!(
            parse_index(r#"{"schema":"redline.extension-index/2","extensions":[]}"#).is_err(),
            "an unknown schema id must be refused, not half-read"
        );
    }

    /// The B4 acceptance rule: a sha mismatch refuses install. Also size and
    /// magic — every byte-level gate.
    #[test]
    fn verify_artifact_refuses_mismatches() {
        let bytes = b"\0asm\x01\0\0\0".to_vec();
        let mut e = entry("x-ext", "0.1.0");
        e.artifact.size = bytes.len() as u64;
        let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        e.artifact.sha256 = hex;
        assert_eq!(verify_artifact(&e, &bytes), Ok(()));

        let mut wrong_sha = e.clone();
        wrong_sha.artifact.sha256 = "b".repeat(64);
        assert!(verify_artifact(&wrong_sha, &bytes)
            .unwrap_err()
            .contains("refusing install"));

        let mut wrong_size = e.clone();
        wrong_size.artifact.size += 1;
        assert!(verify_artifact(&wrong_size, &bytes).is_err());

        let not_wasm = b"MZ\x90\0PE\0\0".to_vec();
        let mut pe = entry("pe-ext", "0.1.0");
        pe.artifact.size = not_wasm.len() as u64;
        pe.artifact.sha256 = Sha256::digest(&not_wasm)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(verify_artifact(&pe, &not_wasm)
            .unwrap_err()
            .contains("bad magic"));
    }

    /// An install writes exactly what `extension.rs` will load at the next
    /// boot: the generated manifest round-trips through the real validator
    /// and matches the index entry field for field.
    #[test]
    fn write_install_produces_a_loadable_extension_dir() {
        let bytes = b"\0asm\x01\0\0\0".to_vec();
        let mut e = entry("market-ext", "0.2.1");
        e.artifact.size = bytes.len() as u64;
        e.artifact.sha256 = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let root =
            std::env::temp_dir().join(format!("rl-marketplace-{}", uuid::Uuid::new_v4()));
        let dir = write_install(&e, &bytes, &root).unwrap();
        assert_eq!(dir, root.join("market-ext"));

        let loaded = extension::load_extension_dir(&dir).expect("generated manifest must load");
        assert!(loaded.manifest.is_wasm());
        assert_eq!(loaded.manifest.name, "market-ext");
        assert_eq!(loaded.manifest.version.as_deref(), Some("0.2.1"));
        assert_eq!(loaded.manifest.scopes, e.scopes);
        assert_eq!(loaded.manifest.events, e.events);
        assert_eq!(
            loaded.module_path().unwrap(),
            dir.join("extension.wasm")
        );
        assert_eq!(std::fs::read(dir.join("extension.wasm")).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn enrich_computes_install_states_and_descriptions() {
        let fresh = entry("fresh-ext", "0.1.0");
        let current = entry("current-ext", "0.1.0");
        let stale = entry("stale-ext", "0.2.0");
        let installed = vec![
            ("current-ext".to_string(), Some("0.1.0".to_string())),
            ("stale-ext".to_string(), Some("0.1.0".to_string())),
        ];
        let market = enrich(vec![fresh, current, stale], &installed);
        let state_of = |name: &str| market.iter().find(|m| m.entry.name == name).unwrap();
        assert_eq!(state_of("fresh-ext").state, InstallState::Installable);
        assert_eq!(state_of("current-ext").state, InstallState::Installed);
        assert_eq!(state_of("stale-ext").state, InstallState::UpdateAvailable);
        assert_eq!(
            state_of("stale-ext").installed_version.as_deref(),
            Some("0.1.0")
        );
        // Consent vocabulary: every scope and event carries a real
        // description (the ABI tests pin full coverage; this pins the join).
        for m in &market {
            for d in m.scope_details.iter().chain(&m.event_details) {
                assert_ne!(d.description, "(undescribed)", "{} undescribed", d.name);
            }
        }
        assert!(state_of("fresh-ext").min_redline_ok);
    }

    /// Every known event has a doc-table purpose (the consent dialog's
    /// event descriptions can never fall back to "(undescribed)").
    #[test]
    fn every_known_event_is_described() {
        for name in redline_extension_abi::events::KNOWN_EVENTS {
            assert!(describe_event(name).is_some(), "event {name} undescribed");
        }
    }

    // -----------------------------------------------------------------
    // Drift guards: the index repo's CI (validate.mjs, staged under
    // marketplace/ until extraction) enforces the same closed vocabularies
    // and license allowlist as the app. These tests pin the mirrors.

    const VALIDATE_MJS: &str =
        include_str!("../../marketplace/redline-extensions/scripts/validate.mjs");
    const DENY_TOML: &str = include_str!("../deny.toml");

    /// Extract the string items of `const NAME = [ ... ]` from validate.mjs.
    fn mjs_list(name: &str) -> Vec<String> {
        let start = VALIDATE_MJS
            .find(&format!("const {name} = ["))
            .unwrap_or_else(|| panic!("validate.mjs: missing `const {name} = [`"));
        let rest = &VALIDATE_MJS[start..];
        let end = rest.find("];").expect("list must close with `];`");
        rest[..end]
            .split('"')
            .skip(1)
            .step_by(2)
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn validate_mjs_mirrors_scope_and_event_vocabularies() {
        assert_eq!(
            mjs_list("KNOWN_SCOPES"),
            redline_extension_abi::scopes::KNOWN_SCOPES
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            mjs_list("KNOWN_EVENTS"),
            redline_extension_abi::events::KNOWN_EVENTS
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
    }

    /// The index CI's license allowlist is deny.toml's, verbatim — one
    /// permissive-licenses policy across app and marketplace.
    #[test]
    fn validate_mjs_mirrors_deny_toml_license_allowlist() {
        let licenses_block = DENY_TOML
            .split("allow = [")
            .nth(1)
            .expect("deny.toml allow list")
            .split(']')
            .next()
            .unwrap();
        let deny_allow: Vec<String> = licenses_block
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                l.strip_prefix('"')?.split('"').next().map(|s| s.to_string())
            })
            .collect();
        assert!(!deny_allow.is_empty(), "deny.toml extraction broke");
        assert_eq!(mjs_list("LICENSE_ALLOW"), deny_allow);
    }

    #[test]
    fn validate_mjs_mirrors_the_artifact_cap() {
        assert!(
            VALIDATE_MJS.contains("const ARTIFACT_CAP_BYTES = 5 * 1024 * 1024;"),
            "validate.mjs artifact cap must mirror ARTIFACT_CAP_BYTES"
        );
        assert_eq!(ARTIFACT_CAP_BYTES, 5 * 1024 * 1024);
    }

    #[test]
    fn index_url_env_override_is_https_or_loopback_only() {
        assert!(url_allowed("https://example.com/index.json"));
        assert!(url_allowed("http://127.0.0.1:9999/index.json"));
        assert!(url_allowed("http://localhost:9999/index.json"));
        assert!(!url_allowed("http://192.168.1.10/index.json"));
        assert!(!url_allowed("file:///etc/passwd"));
    }
}

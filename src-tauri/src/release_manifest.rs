// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What a candidate release *is*, written down.
//!
//! Preparing a replacement Redline produces one immutable artifact and one
//! manifest describing it. The manifest is the only thing the restart path
//! trusts: it names the source the artifact was built from, hashes every file
//! inside the bundle, records how it was signed, which checks passed, what it
//! will do to the user's data, and which helper protocol it speaks.
//!
//! The manifest is **sealed** — hashed over its own canonical form — so that
//! "this is the thing we verified" is a checkable claim rather than a hopeful
//! one. Re-running a check, rebuilding, or touching a byte in the bundle all
//! produce a manifest whose seal no longer matches, and readiness has to be
//! earned again.
//!
//! A small **stamp** ships *inside* the bundle it describes
//! ([`STAMP_FILENAME`], under `Contents/Resources`). That is what makes crash
//! recovery possible: after an interrupted bundle exchange, the question
//! "which release is installed right now?" is answered by reading the bundle
//! itself, not by trusting a journal entry that may never have been written.
//!
//! The stamp is separate from the manifest for a concrete reason. A signature
//! covers everything in the bundle, so anything written into it has to be
//! written *before* signing — and the manifest cannot be, because it records
//! how the signing turned out and hashes the signed result. So the identity
//! goes in, signed and immutable, and the description stays outside beside the
//! artifact.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The manifest schema. A candidate whose manifest this build cannot read is
/// refused rather than guessed at.
pub const MANIFEST_VERSION: u32 = 1;

/// The identity stamp's name inside a bundle's `Contents/Resources`.
pub const STAMP_FILENAME: &str = "redline-release.json";

/// The activation-helper protocol this build speaks. The incumbent's helper
/// drives the exchange, so a candidate that speaks a different protocol cannot
/// be activated by it — it needs a conventional installation instead.
pub const HELPER_PROTOCOL: u32 = 1;

/// The helper's name inside a bundle's `Contents/Resources`.
pub const HELPER_FILENAME: &str = "redline-activate";

/// Where the candidate's source came from, and exactly which bytes they were.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    /// The originating checkout. Recorded explicitly, because a candidate is
    /// built in a temporary directory and that directory must never become the
    /// updater's idea of where Redline's source lives.
    pub repository: String,
    /// The revision the capture was taken from.
    pub base_revision: String,
    /// Content hash over every captured file — including the local
    /// modifications and untracked source that were carried in. Two captures
    /// with the same fingerprint contain the same source.
    pub fingerprint: String,
    /// How many files the capture covered.
    pub file_count: usize,
    /// How many of them differed from `base_revision` at capture time. Shown
    /// during run review so a reviewer can see what came along for the ride.
    pub modified_files: Vec<String>,
    /// Untracked (but not ignored) source files that were included.
    pub untracked_files: Vec<String>,
    /// The approved plan revisions this candidate implements.
    pub plan_revisions: Vec<String>,
    /// The release that was installed when preparation began.
    pub installed_release: Option<String>,
}

/// One file inside the artifact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFile {
    /// Path relative to the bundle root.
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    /// Unix mode bits, so an executable that lost its bit is a difference.
    pub mode: u32,
}

/// The packaged application.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    /// The bundle's name (`Redline.app`). The *location* is deliberately not
    /// part of the identity: the same artifact is staged, swapped and
    /// installed at different paths.
    pub bundle_name: String,
    /// Hash over every file's path, mode and content — the artifact's identity.
    pub sha256: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub files: Vec<ArtifactFile>,
}

/// How the artifact was signed. Signing is done by the trusted controller,
/// never by a command the candidate's own source could choose.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SigningInfo {
    /// The local code-signing identity used, or `None` for ad-hoc.
    pub identity: Option<String>,
    pub ad_hoc: bool,
    /// `codesign --verify --strict` passed.
    pub verified: bool,
    /// The authority chain `codesign -dv` reported.
    pub authority: Vec<String>,
}

/// One check that ran during preparation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub name: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub ok: bool,
    pub duration_ms: u64,
    /// The tail of combined stdout/stderr, capped.
    pub output: String,
}

/// What activating this release would do to data the user already has.
///
/// The distinction that matters is not "does the schema change" but "can the
/// release we would roll back to still read what this one writes". A release
/// that fails that test is not a restart; it is maintenance.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataCompatibility {
    /// The host schema version this build writes.
    pub schema_version: i64,
    /// The independently versioned memory store's schema, checked separately
    /// because it does not share the host's version stamp.
    pub memory_schema: String,
    /// Migration steps activation would run, in order.
    pub migrations: Vec<String>,
    /// The previous release can still open and read the migrated database.
    pub previous_can_read: bool,
    /// Persistent frontend state and external configuration this release
    /// changes the format of.
    pub external_state: Vec<String>,
    /// True when activation cannot be presented as a quick restart: a
    /// destructive conversion, a large backfill, or a change with no supported
    /// recovery path. Such a release is offered as **Requires maintenance**.
    pub requires_maintenance: bool,
    pub notes: String,
}

/// The sealed description of one candidate release.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub manifest_version: u32,
    pub release_id: String,
    pub created_at: i64,
    pub source: SourceRef,
    pub platform: String,
    pub arch: String,
    pub artifact: ArtifactRef,
    pub signing: SigningInfo,
    pub checks: Vec<CheckResult>,
    pub data: DataCompatibility,
    pub helper_protocol: u32,
    /// Set by [`ReleaseManifest::seal`]. Empty while the manifest is still
    /// being assembled.
    pub seal: String,
}

impl ReleaseManifest {
    /// A new, unsealed manifest for `release_id`.
    pub fn new(release_id: impl Into<String>) -> Self {
        Self {
            manifest_version: MANIFEST_VERSION,
            release_id: release_id.into(),
            created_at: now_secs(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            helper_protocol: HELPER_PROTOCOL,
            ..Default::default()
        }
    }

    /// The bytes the seal is computed over: the manifest itself with an empty
    /// seal field, in canonical (key-sorted) JSON.
    fn seal_input(&self) -> Vec<u8> {
        let mut bare = self.clone();
        bare.seal = String::new();
        let value = serde_json::to_value(&bare).unwrap_or(serde_json::Value::Null);
        canonical_json(&value).into_bytes()
    }

    /// Freeze the manifest. Every later question — "is this still the release
    /// we verified?" — is this hash.
    pub fn seal(&mut self) {
        self.seal = hex(&Sha256::digest(self.seal_input()));
    }

    /// True when the manifest has not been edited since it was sealed.
    pub fn seal_intact(&self) -> bool {
        !self.seal.is_empty() && self.seal == hex(&Sha256::digest(self.seal_input()))
    }

    /// Everything that has to hold before this manifest may be offered as a
    /// restart. Returns the reasons it may not.
    pub fn readiness_blockers(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.manifest_version != MANIFEST_VERSION {
            out.push(format!(
                "manifest version {} is not the version this build reads ({MANIFEST_VERSION})",
                self.manifest_version
            ));
        }
        if !self.seal_intact() {
            out.push("the release manifest was modified after it was sealed".into());
        }
        if self.helper_protocol != HELPER_PROTOCOL {
            out.push(format!(
                "this candidate speaks activation protocol {} and the installed helper speaks {HELPER_PROTOCOL}",
                self.helper_protocol
            ));
        }
        if self.platform != std::env::consts::OS || self.arch != std::env::consts::ARCH {
            out.push(format!(
                "built for {}/{}, not {}/{}",
                self.platform,
                self.arch,
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
        }
        if self.artifact.file_count == 0 {
            out.push("the artifact is empty".into());
        }
        if !self.signing.verified {
            out.push("the packaged bundle's signature did not verify".into());
        }
        for check in self.checks.iter().filter(|c| !c.ok) {
            out.push(format!("check '{}' did not pass", check.name));
        }
        if self.data.requires_maintenance {
            out.push("this release changes stored data in a way that needs maintenance, not a restart".into());
        }
        if !self.data.previous_can_read {
            out.push("the previous release could not read this release's data, so there would be no way back".into());
        }
        out
    }

    pub fn is_ready(&self) -> bool {
        self.readiness_blockers().is_empty()
    }

    pub fn write_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(self).unwrap_or_default())
    }

    pub fn read_from(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// The stamp that goes inside the bundle this manifest describes.
    pub fn stamp(&self) -> ReleaseStamp {
        ReleaseStamp {
            manifest_version: self.manifest_version,
            release_id: self.release_id.clone(),
            created_at: self.created_at,
            source_fingerprint: self.source.fingerprint.clone(),
            helper_protocol: self.helper_protocol,
        }
    }
}

/// Who a bundle *is*, written inside it before it is signed.
///
/// Deliberately tiny and deliberately immutable: it has to be readable by a
/// recovering process that cannot open the database, cannot reach the
/// preparation directory, and is deciding whether the application in
/// `/Applications` is the one an interrupted exchange was installing.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStamp {
    pub manifest_version: u32,
    pub release_id: String,
    pub created_at: i64,
    pub source_fingerprint: String,
    pub helper_protocol: u32,
}

impl ReleaseStamp {
    pub fn write_into(&self, bundle: &Path) -> std::io::Result<()> {
        let path = stamp_path_in(bundle);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(self).unwrap_or_default())
    }

    /// Read a bundle's identity, if it has one. `None` for an installation
    /// that predates release stamps — which is different from, and must never
    /// be confused with, "it is the candidate".
    pub fn read_from_bundle(bundle: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(stamp_path_in(bundle)).ok()?).ok()
    }
}

/// Where the identity stamp sits inside a bundle.
pub fn stamp_path_in(bundle: &Path) -> PathBuf {
    bundle.join("Contents/Resources").join(STAMP_FILENAME)
}

/// Where the activation helper sits inside a bundle.
pub fn helper_path_in(bundle: &Path) -> PathBuf {
    bundle.join("Contents/Resources").join(HELPER_FILENAME)
}

/// Serialize a JSON value with object keys sorted, so the same manifest always
/// hashes to the same seal regardless of field order in memory.
pub fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map.iter().collect();
            let parts: Vec<String> = sorted
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json(v)
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Hash one file's contents, streaming so a 40 MB binary never lands in memory
/// twice.
pub fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        hasher.update(&buf[..read]);
    }
    Ok((hex(&hasher.finalize()), total))
}

/// Walk a directory into a sorted list of (relative path, mode, size) entries,
/// following nothing: a symlink is recorded as a symlink, by its target, so a
/// bundle cannot smuggle in a file by pointing at one.
fn walk(root: &Path) -> std::io::Result<Vec<(String, std::fs::Metadata, PathBuf)>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push((rel, meta, path));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

#[cfg(unix)]
fn mode_of(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode()
}
#[cfg(not(unix))]
fn mode_of(_meta: &std::fs::Metadata) -> u32 {
    0o644
}

/// Hash a whole bundle into an [`ArtifactRef`].
///
/// `skip` names paths (relative, `/`-separated) left out of the identity —
/// used for the manifest itself, which cannot contain its own hash.
pub fn hash_bundle(bundle: &Path, skip: &[&str]) -> Result<ArtifactRef, String> {
    let entries = walk(bundle).map_err(|e| format!("{}: {e}", bundle.display()))?;
    let mut files = Vec::with_capacity(entries.len());
    let mut total = 0u64;
    let mut roll = Sha256::new();
    for (rel, meta, path) in entries {
        if skip.contains(&rel.as_str()) {
            continue;
        }
        let mode = mode_of(&meta);
        let (sha, bytes) = if meta.is_symlink() {
            // A symlink's identity is where it points, not what is there.
            let target = std::fs::read_link(&path)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            (
                hex(&Sha256::digest(target.to_string_lossy().as_bytes())),
                0,
            )
        } else {
            hash_file(&path).map_err(|e| format!("{}: {e}", path.display()))?
        };
        roll.update(rel.as_bytes());
        roll.update([0]);
        roll.update(mode.to_be_bytes());
        roll.update(sha.as_bytes());
        roll.update([b'\n']);
        total += bytes;
        files.push(ArtifactFile { path: rel, sha256: sha, bytes, mode });
    }
    Ok(ArtifactRef {
        bundle_name: bundle
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        sha256: hex(&roll.finalize()),
        file_count: files.len(),
        total_bytes: total,
        files,
    })
}

/// Re-hash a bundle on disk and compare it with what the manifest recorded.
/// This is what "the artifact has not changed since we verified it" means, and
/// it is checked again immediately before a restart.
pub fn artifact_matches(bundle: &Path, expected: &ArtifactRef) -> Result<(), String> {
    let actual = hash_bundle(bundle, &[])?;
    if actual.sha256 != expected.sha256 {
        return Err(format!(
            "the bundle at {} is not the artifact that was verified ({} files, {} expected)",
            bundle.display(),
            actual.file_count,
            expected.file_count
        ));
    }
    Ok(())
}

/// Content fingerprint over a captured source tree: every file's relative
/// path, mode and content hash, in sorted order.
pub fn fingerprint_source(root: &Path) -> Result<(String, usize), String> {
    let entries = walk(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut roll = Sha256::new();
    let mut count = 0usize;
    for (rel, meta, path) in entries {
        if rel.starts_with(".git/") || rel == ".git" {
            continue;
        }
        let mode = mode_of(&meta);
        let sha = if meta.is_symlink() {
            let target =
                std::fs::read_link(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            hex(&Sha256::digest(target.to_string_lossy().as_bytes()))
        } else {
            hash_file(&path)
                .map_err(|e| format!("{}: {e}", path.display()))?
                .0
        };
        roll.update(rel.as_bytes());
        roll.update([0]);
        roll.update(mode.to_be_bytes());
        roll.update(sha.as_bytes());
        roll.update([b'\n']);
        count += 1;
    }
    Ok((hex(&roll.finalize()), count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rl-manifest-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ready_manifest() -> ReleaseManifest {
        let mut m = ReleaseManifest::new("rel-1");
        m.artifact.file_count = 3;
        m.artifact.sha256 = "abc".into();
        m.signing.verified = true;
        m.data.previous_can_read = true;
        m.seal();
        m
    }

    #[test]
    fn a_sealed_manifest_detects_any_later_edit() {
        let mut m = ready_manifest();
        assert!(m.seal_intact());
        m.checks.push(CheckResult {
            name: "cargo test".into(),
            command: "cargo test".into(),
            exit_code: Some(0),
            ok: true,
            duration_ms: 10,
            output: String::new(),
        });
        assert!(!m.seal_intact(), "adding a passing check must still break the seal");
        assert!(m
            .readiness_blockers()
            .iter()
            .any(|b| b.contains("modified after it was sealed")));
    }

    #[test]
    fn the_seal_does_not_depend_on_field_order_in_memory() {
        let m = ready_manifest();
        let round: ReleaseManifest =
            serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert!(round.seal_intact());
        assert_eq!(round.seal, m.seal);
    }

    #[test]
    fn readiness_lists_every_reason_not_just_the_first() {
        let mut m = ReleaseManifest::new("rel-2");
        m.helper_protocol = 99;
        m.data.requires_maintenance = true;
        m.checks.push(CheckResult {
            name: "frontend".into(),
            command: "npm test".into(),
            exit_code: Some(1),
            ok: false,
            duration_ms: 1,
            output: String::new(),
        });
        m.seal();
        let blockers = m.readiness_blockers();
        assert!(!m.is_ready());
        assert!(blockers.iter().any(|b| b.contains("protocol")));
        assert!(blockers.iter().any(|b| b.contains("maintenance")));
        assert!(blockers.iter().any(|b| b.contains("frontend")));
        assert!(blockers.iter().any(|b| b.contains("signature")));
        assert!(blockers.iter().any(|b| b.contains("no way back")));
    }

    #[test]
    fn a_release_with_no_way_back_is_never_ready() {
        let mut m = ready_manifest();
        m.data.previous_can_read = false;
        m.seal();
        assert!(!m.is_ready());
    }

    #[test]
    fn artifact_identity_covers_content_mode_and_layout() {
        let dir = tmp("artifact");
        let bundle = dir.join("Redline.app");
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(bundle.join("Contents/MacOS/redline"), b"binary").unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), b"plist").unwrap();
        let first = hash_bundle(&bundle, &[]).unwrap();
        assert_eq!(first.file_count, 2);

        // Same bytes, re-hashed: identical.
        assert_eq!(hash_bundle(&bundle, &[]).unwrap().sha256, first.sha256);
        artifact_matches(&bundle, &first).expect("an untouched bundle still matches");

        // One byte changed: different.
        std::fs::write(bundle.join("Contents/MacOS/redline"), b"binaries").unwrap();
        assert_ne!(hash_bundle(&bundle, &[]).unwrap().sha256, first.sha256);

        // Restored content but a moved file: still different.
        std::fs::write(bundle.join("Contents/MacOS/redline"), b"binary").unwrap();
        std::fs::rename(
            bundle.join("Contents/Info.plist"),
            bundle.join("Contents/Info2.plist"),
        )
        .unwrap();
        assert_ne!(hash_bundle(&bundle, &[]).unwrap().sha256, first.sha256);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn a_lost_executable_bit_is_a_different_artifact() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("mode");
        let bundle = dir.join("Redline.app");
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        let bin = bundle.join("Contents/MacOS/redline");
        std::fs::write(&bin, b"binary").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let signed = hash_bundle(&bundle, &[]).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(artifact_matches(&bundle, &signed).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_stamp_goes_in_before_signing_and_is_part_of_the_identity() {
        let dir = tmp("stamp");
        let bundle = dir.join("Redline.app");
        std::fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        std::fs::write(bundle.join("Contents/Resources/asset.txt"), b"x").unwrap();
        let mut m = ReleaseManifest::new("rel-3");
        m.source.fingerprint = "fingerprint".into();
        // The stamp is written first, so it is inside what gets signed and
        // inside what gets hashed.
        m.stamp().write_into(&bundle).unwrap();
        m.artifact = hash_bundle(&bundle, &[]).unwrap();
        m.seal();
        artifact_matches(&bundle, &m.artifact).expect("the sealed artifact is the one on disk");
        let stamp = ReleaseStamp::read_from_bundle(&bundle).unwrap();
        assert_eq!(stamp.release_id, "rel-3");
        assert_eq!(stamp.source_fingerprint, "fingerprint");
        // Editing the stamp afterwards is a different artifact — which is the
        // whole point of it being inside the hash.
        ReleaseStamp { release_id: "rel-impostor".into(), ..stamp }
            .write_into(&bundle)
            .unwrap();
        assert!(artifact_matches(&bundle, &m.artifact).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_source_fingerprint_covers_untracked_and_modified_files() {
        let dir = tmp("fingerprint");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), b"fn main() {}").unwrap();
        let (base, count) = fingerprint_source(&dir).unwrap();
        assert_eq!(count, 1);
        // An untracked source file changes the fingerprint...
        std::fs::write(dir.join("src/new.rs"), b"// new").unwrap();
        let (with_new, count2) = fingerprint_source(&dir).unwrap();
        assert_ne!(base, with_new);
        assert_eq!(count2, 2);
        // ...and so does editing an existing one.
        std::fs::write(dir.join("src/lib.rs"), b"fn main() { }").unwrap();
        assert_ne!(fingerprint_source(&dir).unwrap().0, with_new);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_metadata_is_not_part_of_the_source_fingerprint() {
        // The candidate keeps its own private repository; its commit ids must
        // not make two identical source trees look different.
        let dir = tmp("gitignore");
        std::fs::create_dir_all(dir.join(".git/objects")).unwrap();
        std::fs::write(dir.join("a.rs"), b"x").unwrap();
        let before = fingerprint_source(&dir).unwrap();
        std::fs::write(dir.join(".git/objects/deadbeef"), b"commit").unwrap();
        assert_eq!(fingerprint_source(&dir).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_depth() {
        let a: serde_json::Value =
            serde_json::from_str(r#"{"b":1,"a":{"z":2,"y":[{"q":1,"p":0}]}}"#).unwrap();
        let b: serde_json::Value =
            serde_json::from_str(r#"{"a":{"y":[{"p":0,"q":1}],"z":2},"b":1}"#).unwrap();
        assert_eq!(canonical_json(&a), canonical_json(&b));
    }
}

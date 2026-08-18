// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The typed scaffold behind `project_create`'s `kind: "extension"` — the
//! additive third step after README + `git init` that turns an empty folder
//! into a buildable Redline extension crate.
//!
//! Everything here writes INSIDE the new project directory and nowhere else.
//! That confinement is the property the whole harness-platform shape rests
//! on: nothing a pack author's session writes may live under `src-tauri/`,
//! or the cargo watcher rebuilds Redline out from under the session hosting
//! the work. The scaffold *reads* the staged SDK (a Cargo path dependency)
//! but building the scaffolded crate compiles into the project's own
//! `target/`, so the dependency edge never writes back.
//!
//! Modeled line-for-line on `marketplace/redline-extension-template` — the
//! publisher story — but minimal: the template stays the worked example (the
//! front-door launch grants it via `--add-dir`), this is the starting point.

use std::path::{Path, PathBuf};

/// A directory of the Redline checkout this binary was built from, or `None`
/// once the clone has moved. Same runtime pattern as `update::repo_root`:
/// Redline is source-distributed, so `CARGO_MANIFEST_DIR` (= `<repo>/src-tauri`
/// at build time) points into the user's own clone.
fn dev_dir(rel: &str) -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    dir.is_dir().then_some(dir)
}

/// The extension ABI crate — the wire contract an author codes against.
pub fn abi_dir() -> Option<PathBuf> {
    dev_dir("crates/redline-extension-abi")
}

/// The extension SDK crate — the scaffold's one path dependency.
pub fn sdk_dir() -> Option<PathBuf> {
    dev_dir("crates/redline-extension-sdk")
}

/// The worked-example extension crate (the marketplace template).
pub fn template_dir() -> Option<PathBuf> {
    dev_dir("../marketplace/redline-extension-template")
}

/// An extension name derived from a project slug. The slug grammar
/// (`slugify_project_name`) allows `.`, which `extension::valid_name` does
/// not — so dots fold to dashes, runs collapse, edges trim, and the result
/// is capped at the manifest's 32. A slug is never empty, so neither is
/// this; the fallback is belt-and-braces for a degenerate all-dot slug.
pub fn extension_name_from_slug(slug: &str) -> String {
    let mut name = String::with_capacity(slug.len());
    for ch in slug.chars() {
        let mapped = if ch == '.' { '-' } else { ch };
        if mapped == '-' && (name.ends_with('-') || name.is_empty()) {
            continue;
        }
        name.push(mapped);
        if name.len() >= 32 {
            break;
        }
    }
    let name = name.trim_matches('-').to_string();
    if name.is_empty() {
        "extension".to_string()
    } else {
        name
    }
}

/// The SDK dependency line. A path dep on the staged crate while the clone
/// exists (the normal case for a source-distributed app); the crates.io
/// version line — same version family as the ABI's `api_version` — when the
/// checkout has moved, so the scaffold still names its dependency honestly.
fn sdk_dependency() -> String {
    match sdk_dir() {
        Some(dir) => format!(
            "redline-extension-sdk = {{ path = \"{}\" }}",
            dir.display()
        ),
        None => "redline-extension-sdk = \"1\"".to_string(),
    }
}

fn manifest_json(name: &str) -> String {
    format!(
        r#"{{
  "name": "{name}",
  "version": "0.1.0",
  "kind": "wasm",
  "module": "extension.wasm",
  "api_version": {api},
  "scopes": ["plan.comment"],
  "events": ["plan.received"]
}}
"#,
        api = redline_extension_abi::API_VERSION,
    )
}

fn cargo_toml(name: &str) -> String {
    format!(
        r#"# A Redline WASM extension. The package name, the folder name, and the
# `name` in extension.json must all match.
[package]
name = "{name}"
version = "0.1.0"
edition = "2021"
license = "Apache-2.0"

# Extensions are core-wasm dynamic libraries (`wasm32-unknown-unknown`).
[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
{sdk}
serde_json = "1"

# Standalone package — deliberately not a member of any parent workspace.
[workspace]

[profile.release]
opt-level = "s"
lto = true
strip = true
"#,
        sdk = sdk_dependency(),
    )
}

fn lib_rs(name: &str) -> String {
    format!(
        r##"//! {name}: a Redline extension. Everything an extension can be is visible
//! from here — events in, authorized `host_call`s out, nothing else. The
//! scopes and events this code assumes are declared in extension.json.

use redline_extension_sdk as sdk;
use sdk::{{Event, Extension, Host}};

#[derive(Default)]
struct Scaffold;

impl Extension for Scaffold {{
    fn on_event(&mut self, host: &dyn Host, event: &Event) -> Result<(), String> {{
        if let Event::PlanReceived(plan) = event {{
            // Requires scope `plan.comment` (declared in extension.json).
            let resp = sdk::plan::comment(
                host,
                &plan.session_id,
                &format!("{name}: plan v{{}} received", plan.version),
                None,
            );
            if resp.status >= 400 {{
                return Err(format!("plan.comment failed: {{}} {{}}", resp.status, resp.body));
            }}
        }}
        Ok(())
    }}
}}

sdk::export!(Scaffold);

// Unit tests run as plain Rust against MockHost — no wasm toolchain needed.
#[cfg(test)]
mod tests {{
    use super::*;
    use sdk::abi::events;
    use sdk::testing::MockHost;

    #[test]
    fn comments_on_a_received_plan() {{
        let host = MockHost::new().respond(
            "POST",
            "/v1/sessions/s-1/comments",
            201,
            r#"{{"id":"c1"}}"#,
        );
        let mut ext = Scaffold::default();
        let event = Event::decode(
            events::PLAN_RECEIVED,
            &serde_json::to_string(&events::PlanReceived {{
                session_id: "s-1".into(),
                version: 3,
                is_new_session: false,
                thread_start: false,
                mode: "revise".into(),
                restored: false,
                ts_ms: 0,
            }})
            .unwrap(),
        );
        ext.on_event(&host, &event).unwrap();
        assert_eq!(host.calls().len(), 1);
    }}
}}
"##
    )
}

const BUILD_SH: &str = r#"#!/bin/sh
# Build the extension and place the module next to extension.json. To run
# it: Redline > Settings > Extensions > "Install from folder..." links THIS
# folder and hot-loads it — after that, rebuild here and press Reload on
# the extension's row. No copying, no relaunch.
set -eu
cd "$(dirname "$0")"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --release --target wasm32-unknown-unknown
cp "target/wasm32-unknown-unknown/release/$(sed -n 's/^name = "\(.*\)"$/\1/p' Cargo.toml | head -1 | tr '-' '_').wasm" extension.wasm
ls -la extension.wasm
shasum -a 256 extension.wasm
"#;

// `.token`: a link-installed external extension (A5a) gets its per-boot
// scoped token written through the link into THIS folder — never committed.
const GITIGNORE: &str = "/target\n.token\n";

/// Write one scaffold file, refusing to clobber. `project_create` already
/// guarantees the directory was empty (modulo the README it just wrote), so
/// an existing file here means a bug or a race — either way, leave it alone.
fn seed_file(dir: &Path, rel: &str, contents: &str) -> Result<(), String> {
    let path = dir.join(rel);
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, contents)
        .map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

/// Seed an extension-pack project into `dir` (already created, already
/// slug-named). Fallible as a unit: a half-scaffolded project would present
/// as a working one, so the first failed write aborts with its reason.
pub fn seed(dir: &Path, slug: &str) -> Result<(), String> {
    let name = extension_name_from_slug(slug);
    seed_file(dir, "extension.json", &manifest_json(&name))?;
    seed_file(dir, "Cargo.toml", &cargo_toml(&name))?;
    seed_file(dir, "src/lib.rs", &lib_rs(&name))?;
    seed_file(dir, "build.sh", BUILD_SH)?;
    seed_file(dir, ".gitignore", GITIGNORE)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            dir.join("build.sh"),
            std::fs::Permissions::from_mode(0o755),
        );
    }
    Ok(())
}

// --- Harness packs (A5a) -----------------------------------------------------

/// Seed a harness-pack project: one `harness.json`, no toolchain, no build
/// step — the pack is data the shell composes (A5). The manifest ships with
/// every axis visibly pulled (surfaces, header order, landing, labels,
/// hero) so the file teaches its own edit loop; the hero's sub says out
/// loud how to see a change land.
pub fn seed_harness(dir: &Path, slug: &str, display_name: &str) -> Result<(), String> {
    let id = extension_name_from_slug(slug);
    let name = display_name.trim();
    let name = if name.is_empty() { id.as_str() } else { name };
    let manifest = serde_json::json!({
        "id": id,
        "name": name,
        "version": 1,
        "workspace": {
            "surfaces": { "review": false },
            "header": { "order": ["document", "drafter"] },
            "landing": "drafter",
        },
        "labels": {
            "drafter": { "label": "Desk", "title": format!("The {name} desk") },
        },
        "hero": {
            "eyebrow": name,
            "title": "Say what this harness is for.",
            "sub": "Edit harness.json — surfaces, labels, landing, this hero — \
                    then refocus Redline: the change is live.",
        },
    });
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
    );
    seed_file(dir, "harness.json", &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("redline-scaffold-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn slug_to_extension_name_folds_dots_and_stays_valid() {
        assert_eq!(extension_name_from_slug("my-pack"), "my-pack");
        assert_eq!(extension_name_from_slug("v2.1"), "v2-1");
        assert_eq!(extension_name_from_slug("a...b"), "a-b");
        assert_eq!(extension_name_from_slug("legal_pack"), "legal_pack");
        let long = extension_name_from_slug(&"x".repeat(64));
        assert_eq!(long.len(), 32);
        // Every name the fold produces passes the manifest's own gate.
        for slug in ["my-pack", "v2.1", "a...b", "legal_pack", "9lives"] {
            assert!(
                crate::extension::valid_name(&extension_name_from_slug(slug)),
                "{slug} produced an invalid extension name"
            );
        }
    }

    #[test]
    fn seeds_the_five_files_and_they_agree_on_the_name() {
        let dir = tmp();
        seed(&dir, "v2.1-pack").unwrap();
        for rel in ["extension.json", "Cargo.toml", "src/lib.rs", "build.sh", ".gitignore"] {
            assert!(dir.join(rel).is_file(), "missing {rel}");
        }
        let manifest = std::fs::read_to_string(dir.join("extension.json")).unwrap();
        let cargo = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
        // The template's rule: extension.json `name` and the cargo package
        // name must match (the folder is the caller's job).
        assert!(manifest.contains("\"name\": \"v2-1-pack\""));
        assert!(cargo.contains("name = \"v2-1-pack\""));
        // The manifest carries the live ABI version, not a hardcoded one.
        assert!(manifest.contains(&format!(
            "\"api_version\": {}",
            redline_extension_abi::API_VERSION
        )));
        let parsed: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(parsed["kind"], "wasm");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scaffold_writes_only_inside_the_project_dir() {
        // The load-bearing confinement: nothing may land under src-tauri/, or
        // the cargo watcher rebuilds Redline mid-session. Everything seed()
        // writes is under `dir` by construction (seed_file joins onto it);
        // this pins the file SET so a new write site has to come past here.
        let dir = tmp();
        seed(&dir, "confined").unwrap();
        let mut files = Vec::new();
        fn walk(root: &Path, base: &Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(root).unwrap().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    out.push(p.strip_prefix(base).unwrap().to_string_lossy().into_owned());
                }
            }
        }
        walk(&dir, &dir, &mut files);
        files.sort();
        assert_eq!(
            files,
            vec![".gitignore", "Cargo.toml", "build.sh", "extension.json", "src/lib.rs"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_never_clobbers_an_existing_file() {
        let dir = tmp();
        std::fs::write(dir.join("Cargo.toml"), "# mine\n").unwrap();
        seed(&dir, "pack").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("Cargo.toml")).unwrap(),
            "# mine\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_sh_is_executable_on_unix() {
        let dir = tmp();
        seed(&dir, "pack").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("build.sh")).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "build.sh not executable");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole-gate check: the generated crate actually compiles against
    /// the staged SDK and its MockHost test passes — as plain host Rust, no
    /// wasm target required. `#[ignore]` because it spawns a full cargo
    /// build (~a minute cold); run it whenever the scaffold templates or the
    /// SDK surface change:
    ///   cargo test -p redline --lib scaffolded_crate -- --ignored --test-threads=1
    #[test]
    #[ignore]
    fn scaffolded_crate_compiles_and_its_test_passes() {
        let dir = tmp();
        seed(&dir, "gate-check").unwrap();
        let out = std::process::Command::new("cargo")
            .arg("test")
            .current_dir(&dir)
            .output()
            .expect("cargo not runnable");
        assert!(
            out.status.success(),
            "scaffolded crate failed:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_seed_writes_one_installable_manifest() {
        let dir = tmp();
        seed_harness(&dir, "closing.desk", "Closing Desk").unwrap();
        // One file, nothing else — a pack has no toolchain to scaffold.
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["harness.json"]);
        let raw = std::fs::read_to_string(dir.join("harness.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // The id folds like an extension name (it becomes the install dir),
        // the name stays the user's words.
        assert_eq!(parsed["id"], "closing-desk");
        assert_eq!(parsed["name"], "Closing Desk");
        assert!(crate::extension::valid_name(parsed["id"].as_str().unwrap()));
        // The seeded file passes the INSTALL gate as-is — scaffold-then-link
        // must never need a hand edit first.
        let identity = crate::local_install::read_harness_identity(&dir).unwrap();
        assert_eq!(identity.id, "closing-desk");
        // Every axis a manifest can pull is visibly pulled.
        for key in ["workspace", "labels", "hero"] {
            assert!(parsed.get(key).is_some(), "scaffold missing {key}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_seed_never_clobbers() {
        let dir = tmp();
        std::fs::write(dir.join("harness.json"), "{\"id\":\"mine\"}").unwrap();
        seed_harness(&dir, "pack", "Pack").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("harness.json")).unwrap(),
            "{\"id\":\"mine\"}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sdk_dependency_points_at_the_staged_crate_in_a_dev_tree() {
        // In this checkout the staged SDK exists, so the path dep is used and
        // it is absolute — a scaffolded project lives OUTSIDE the repo, where
        // a relative path would dangle.
        if let Some(dir) = sdk_dir() {
            let dep = sdk_dependency();
            assert!(dep.contains(&dir.display().to_string()));
            assert!(dir.is_absolute());
        }
    }
}

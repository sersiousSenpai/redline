// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Where the Polis Memory crates are, asked of cargo.
//!
//! Redline links the memory crates (`polis-core`, `polis-store`, …) as a
//! dependency — a path while they were staged under `crates/polis/`, a git
//! rev since Session A7 of the extraction (docs/polis-extraction.md), a
//! crates.io version later. Several guards read those crates' SOURCES (the
//! store's lock discipline, the retrieval modules' read-only law, the core's
//! manifest) and must keep reading the real files wherever cargo put them.
//! `cargo metadata` is the one authority on that, so it is asked once here.
//!
//! Shared by the integration tests (`mod common;`) and the lib's own unit
//! tests (`lib.rs` mounts this file as `crate::polis_src` under `cfg(test)`).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// `cargo metadata` for this workspace, parsed once. `--locked`: a test must
/// never rewrite `Cargo.lock`. NOT `--offline`: metadata reads every
/// package's manifest, including the other platforms' crates the build never
/// fetched, so on a cold cache (CI) an offline call fails before it starts —
/// it did, on the first main push after the extraction.
pub fn metadata() -> &'static serde_json::Value {
    static META: OnceLock<serde_json::Value> = OnceLock::new();
    META.get_or_init(|| {
        let out = Command::new(env!("CARGO"))
            .args(["metadata", "--format-version", "1", "--locked"])
            .arg("--manifest-path")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
            .output()
            .expect("run `cargo metadata`");
        assert!(
            out.status.success(),
            "cargo metadata failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).expect("cargo metadata is JSON")
    })
}

/// One `polis-*` package as cargo resolved it for this workspace.
pub struct PolisPackage {
    pub name: String,
    /// Its `Cargo.toml`, wherever cargo put the crate.
    pub manifest: PathBuf,
    /// `None` for a path dependency; `git+…#sha` / `registry+…` otherwise.
    pub source: Option<String>,
    /// The RESOLVED feature set — after unification across the whole graph.
    pub features: Vec<String>,
}

/// Every package in the graph whose name starts with `polis-`, sorted by
/// name. Read from the resolve graph so a crate that arrives later (E1's
/// `polis-mcp`) is covered without touching the guards.
pub fn polis_packages() -> Vec<PolisPackage> {
    let meta = metadata();
    let packages = meta["packages"].as_array().expect("packages");
    let nodes = meta["resolve"]["nodes"].as_array().expect("resolve.nodes");
    let mut out = Vec::new();
    for p in packages {
        let name = p["name"].as_str().unwrap_or_default();
        if !name.starts_with("polis-") {
            continue;
        }
        let id = p["id"].as_str().expect("package id");
        let features = nodes
            .iter()
            .find(|n| n["id"].as_str() == Some(id))
            .map(|n| {
                n["features"]
                    .as_array()
                    .map(|f| f.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        out.push(PolisPackage {
            name: name.to_string(),
            manifest: PathBuf::from(p["manifest_path"].as_str().expect("manifest_path")),
            source: p["source"].as_str().map(String::from),
            features,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The directory holding a polis crate's `Cargo.toml`.
pub fn polis_crate_dir(name: &str) -> PathBuf {
    polis_packages()
        .into_iter()
        .find(|p| p.name == name)
        .unwrap_or_else(|| panic!("{name} is not in Redline's dependency graph"))
        .manifest
        .parent()
        .expect("a manifest has a parent")
        .to_path_buf()
}

/// A source file of a polis crate, by crate name and crate-relative path
/// (`polis_source("polis-store", "src/lib.rs")`).
pub fn polis_source(name: &str, rel: &str) -> String {
    let path = polis_crate_dir(name).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// A manifest with its comment lines removed — the crates' own manifests
/// explain the rules by name, which must not itself trip a scrape.
pub fn manifest_code(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .map(|l| l.split('#').next().unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The dependency names a `[dependencies]` table declares, in order.
pub fn dependency_names(section: &str) -> Vec<String> {
    section
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('['))
        .filter_map(|l| l.split('=').next())
        .map(|n| n.trim().trim_matches('"').to_string())
        .collect()
}

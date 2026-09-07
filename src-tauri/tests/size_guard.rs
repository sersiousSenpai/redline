//! Source-level size-budget guards (docs/perf-budget.md "Size budget").
//!
//! Tests build in debug, so a reverted release profile would never show up in
//! any measurable test artifact — instead the manifest text itself is pinned,
//! the same source-invariant pattern `perf_guard.rs` uses for command hygiene.

static MANIFEST: &str = include_str!("../Cargo.toml");
static MCP_MANIFEST: &str = include_str!("../crates/redline-mcp/Cargo.toml");

#[test]
fn release_profile_keeps_size_levers() {
    for key in [
        "[profile.release]",
        "lto = \"thin\"",
        "codegen-units = 1",
        "strip = \"symbols\"",
    ] {
        assert!(
            MANIFEST.contains(key),
            "src-tauri/Cargo.toml lost `{key}` — the release profile is the \
             foundation of the size budget (docs/perf-budget.md); removing a \
             lever must be a deliberate, reviewed change to this test too"
        );
    }
}

#[test]
fn panic_strategy_stays_unwind() {
    assert!(
        !MANIFEST.contains("panic = \"abort\""),
        "panic=abort would shed ~2 MB of unwind tables but silently disables \
         catch_unwind — thread/task panic containment and the extension \
         host's crash isolation depend on unwind (docs/perf-budget.md)"
    );
}

#[test]
fn mcp_proxy_stays_split_and_lean() {
    // The workspace split is a size lever: as a src/bin/ of the app package
    // the proxy linked all of redline_lib (~28 MB); as its own crate it is
    // ~2 MB. default-members keeps it building under plain `cargo build` /
    // `tauri dev`, which invoke cargo without `-p` — the settings surface's
    // ~/.claude.json snippet points at target/<profile>/redline-mcp.
    // Layout-agnostic (the member lists grew with the B3 extension crates):
    // the proxy must appear in BOTH lists, and "." must stay a default
    // member so plain `cargo build` / `tauri dev` still build the app.
    let section = |name: &str| -> &str {
        let start = MANIFEST.find(name).unwrap_or(0);
        let rest = &MANIFEST[start..];
        let end = rest[name.len()..]
            .find(']')
            .map(|i| i + name.len() + 1)
            .unwrap_or(rest.len());
        &rest[..end]
    };
    let members = section("members = [");
    let default_members = section("default-members = [");
    assert!(
        members.contains("\"crates/redline-mcp\"")
            && default_members.contains("\"crates/redline-mcp\"")
            && default_members.contains("\".\""),
        "src-tauri/Cargo.toml lost the redline-mcp workspace membership — \
         folding the proxy back into the app package re-fattens it to ~28 MB \
         (docs/perf-budget.md 'Size budget')"
    );
    assert!(
        !MANIFEST.contains("\"blocking\""),
        "the app's reqwest regained the `blocking` feature — its only user \
         was the redline-mcp proxy, which now carries its own reqwest in \
         crates/redline-mcp (docs/perf-budget.md 'Size budget')"
    );
    // Comment lines are exempt: the manifest's own header explains this rule
    // by name, which must not itself trip the guard.
    let mcp_code = MCP_MANIFEST
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<String>();
    assert!(
        !mcp_code.contains("redline_lib") && !mcp_code.contains("path = \"../..\""),
        "crates/redline-mcp must never depend on redline_lib — that link is \
         exactly what the workspace split removed; share code by moving it \
         into the proxy crate, not by importing the app"
    );
}

#[test]
fn lib_stays_rlib_only() {
    assert!(
        MANIFEST.contains("crate-type = [\"rlib\"]"),
        "the lib grew extra crate-types — staticlib/cdylib are mobile-only \
         link kinds that cost a full extra link per build; restore them only \
         with a mobile target (docs/perf-budget.md)"
    );
}

// ---------------------------------------------------------------------------
// Polis Memory (docs/polis-extraction.md, Session A7). The memory crates are
// a dependency Redline pulls in — staged by path during Program A, by git rev
// after A7, by crates.io version later — and two things about them are size
// levers the app must hold from ITS side of the boundary:
//
//   * `polis-core` is the vocabulary every consumer compiles against. If it
//     ever grows a native or platform dependency, every crate in the graph
//     inherits it (a Linux daemon linking objc2, a bundle verifier linking
//     SQLite). The manifest AND the resolved tree are both checked, because a
//     manifest scrape cannot see a dependency that arrived through a feature.
//   * Redline's polis dependencies enable nothing that fattens the app:
//     never `cli` (clap + the standalone daemon), `standalone` (a second
//     listener), `anthropic` / `openai-compat` (a second reqwest). Cargo
//     unifies features per graph, so the check reads the RESOLVED feature set
//     of each polis package, not just the lines in this manifest.
//
// Both guards find the crates through `cargo metadata`, so they read the real
// manifests wherever cargo put them (`crates/polis/…` while staged, the git
// checkout after the extraction) rather than a path that stops existing.
// ---------------------------------------------------------------------------

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// `cargo metadata` for this workspace, parsed once. `--locked --offline`:
/// a test must never rewrite `Cargo.lock` or reach the network — everything
/// it needs was fetched by the build that produced this test binary.
fn metadata() -> &'static serde_json::Value {
    static META: OnceLock<serde_json::Value> = OnceLock::new();
    META.get_or_init(|| {
        let out = Command::new(env!("CARGO"))
            .args(["metadata", "--format-version", "1", "--locked", "--offline"])
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

/// Every package in the graph whose name starts with `polis-`, as
/// `(name, manifest path, source, resolved features)`. Read from the resolve
/// graph so a crate that arrives later (E1's `polis-mcp`) is covered without
/// touching this file.
fn polis_packages() -> Vec<(String, PathBuf, Option<String>, Vec<String>)> {
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
        out.push((
            name.to_string(),
            PathBuf::from(p["manifest_path"].as_str().expect("manifest_path")),
            p["source"].as_str().map(String::from),
            features,
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// A manifest with its comment lines removed — the crates' own manifests
/// explain these rules by name, which must not itself trip a scrape.
fn manifest_code(path: &std::path::Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .map(|l| l.split('#').next().unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The dependency names a `[dependencies]` table declares, in order.
fn dependency_names(section: &str) -> Vec<String> {
    section
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('['))
        .filter_map(|l| l.split('=').next())
        .map(|n| n.trim().trim_matches('"').to_string())
        .collect()
}

#[test]
fn core_has_no_native_deps_by_default() {
    let packages = polis_packages();
    let (_, manifest, _, _) = packages
        .iter()
        .find(|(n, ..)| n == "polis-core")
        .expect("polis-core is in the graph");
    let code = manifest_code(manifest);

    // 1. The manifest: exactly the three vocabulary crates, and no table that
    //    could hide a fourth (a `[target.'cfg(…)']` block is how polis-embed
    //    carries objc2; a build script is how a -sys crate arrives).
    assert!(
        !code.contains("[target.") && !code.contains("[build-dependencies]"),
        "polis-core's manifest grew a target or build-dependency table — the \
         core is platform-free by design (docs/polis-extraction.md rule 3)"
    );
    let deps_table = code
        .split("[dependencies]")
        .nth(1)
        .expect("polis-core has a [dependencies] table");
    let deps_table = deps_table.split("\n[").next().unwrap_or(deps_table);
    assert_eq!(
        dependency_names(deps_table),
        ["serde", "serde_json", "sha2"],
        "polis-core's manifest names a dependency beyond serde/serde_json/sha2"
    );

    // 2. The resolved tree: what cargo actually links one edge below the
    //    crate, on this platform, with this workspace's features unified in.
    //    (`--edges normal` leaves out build and dev edges; depth 1 is the
    //    crate's own dependency list.)
    let out = Command::new(env!("CARGO"))
        .args(["tree", "-p", "polis-core", "--edges", "normal", "--depth", "1", "--locked", "--offline"])
        .arg("--manifest-path")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .output()
        .expect("run `cargo tree`");
    assert!(out.status.success(), "cargo tree failed:\n{}", String::from_utf8_lossy(&out.stderr));
    let tree = String::from_utf8_lossy(&out.stdout);
    let mut lines = tree.lines();
    let root = lines.next().unwrap_or_default();
    assert!(root.starts_with("polis-core v"), "unexpected tree root: {root:?}");
    let mut children: Vec<String> = lines
        .filter_map(|l| l.split(['├', '└']).nth(1))
        .filter_map(|l| l.split_whitespace().find(|w| !w.starts_with('─')))
        .map(String::from)
        .collect();
    children.sort();
    assert_eq!(
        children,
        ["serde", "serde_json", "sha2"],
        "cargo tree shows polis-core linking beyond serde/serde_json/sha2:\n{tree}"
    );
}

#[test]
fn polis_deps_stay_lean() {
    let packages = polis_packages();
    for required in ["polis-core", "polis-store", "polis-embed", "polis-llm", "polis-memory", "polis-server"] {
        assert!(
            packages.iter().any(|(n, ..)| n == required),
            "{required} is not in Redline's dependency graph — the guard would pass vacuously"
        );
    }

    // 1. Nothing under polis-memory depends on the app. The same law
    //    `mcp_proxy_stays_split_and_lean` holds for redline-mcp; here it is
    //    what makes the crates extractable at all.
    for (name, manifest, ..) in &packages {
        for line in manifest_code(manifest).lines().map(str::trim) {
            let names_the_app = line.starts_with("redline")
                || line.contains("redline_lib")
                || line.contains("package = \"redline\"");
            assert!(
                !names_the_app,
                "{name}'s manifest names Redline (`{line}`) — Polis never depends on \
                 Redline (docs/polis-extraction.md rule 3)"
            );
        }
    }

    // 2. All polis crates come from ONE place. Half by path and half by git
    //    would compile two copies of the vocabulary and unify nothing.
    let sources: std::collections::BTreeSet<Option<&str>> =
        packages.iter().map(|(_, _, s, _)| s.as_deref()).collect();
    assert_eq!(
        sources.len(),
        1,
        "the polis crates resolve from more than one source: {sources:?}"
    );

    // 3. What this manifest ASKS for: `apple` on the two embedding crates and
    //    nothing else — never a fattening feature.
    const FATTENING: &[&str] = &["cli", "standalone", "anthropic", "openai-compat"];
    let mut asked = 0;
    for line in MANIFEST.lines().map(str::trim) {
        if !line.starts_with("polis-") || !line.contains('=') {
            continue;
        }
        asked += 1;
        let key = line.split('=').next().unwrap().trim();
        let features: Vec<&str> = line
            .split("features = [")
            .nth(1)
            .map(|rest| rest.split(']').next().unwrap_or_default())
            .map(|list| list.split(',').map(|f| f.trim().trim_matches('"')).filter(|f| !f.is_empty()).collect())
            .unwrap_or_default();
        let allowed: &[&str] = match key {
            "polis-embed" | "polis-memory" => &["apple"],
            _ => &[],
        };
        for f in &features {
            assert!(
                allowed.contains(f),
                "src-tauri/Cargo.toml enables `{f}` on {key} — the app's polis deps may \
                 enable only {allowed:?} (docs/perf-budget.md 'Size budget')"
            );
        }
    }
    assert!(asked >= 6, "found only {asked} polis dependency lines in src-tauri/Cargo.toml");

    // 4. What cargo RESOLVED, after unifying every feature request in the
    //    graph — the number that actually decides what gets linked.
    for (name, _, _, features) in &packages {
        for f in features {
            assert!(
                !FATTENING.contains(&f.as_str()),
                "{name} resolved with feature `{f}` enabled — something in the graph \
                 (feature unification) turned on a lever the app must never carry; \
                 find the requester with `cargo tree -e features -i {name}`"
            );
        }
        let allowed: &[&str] = match name.as_str() {
            "polis-embed" | "polis-memory" => &["default", "apple"],
            _ => &["default"],
        };
        for f in features {
            assert!(
                allowed.contains(&f.as_str()),
                "{name} resolved with feature `{f}` — allowed here: {allowed:?}"
            );
        }
    }
}

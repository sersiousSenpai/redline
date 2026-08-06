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

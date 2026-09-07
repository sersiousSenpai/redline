// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `polis-core` — the pure heart of Polis Memory.
//!
//! Everything here is data and arithmetic: the hash-chained ledger's
//! vocabulary and hashing ([`ledger`]), the read-side row types ([`types`]),
//! the query planner ([`query`]) and near-duplicate suppression ([`dedup`]),
//! the classifier's proposal grammar ([`proposal`]) and the coldness interlock
//! ([`coldness`]), the answer pack's types, byte budget, fusion and render
//! ([`pack`]), the verifiable export bundle ([`bundle`]), the deterministic
//! gist ([`gist`]), the tolerant JSON extractor every agent-reply parser uses
//! ([`json`]), and the [`MemoryApi`] trait — the ONE surface the store, the
//! HTTP server, the MCP server and the generated clients speak.
//!
//! No I/O, no database, no async runtime. A bundle verifies with this crate
//! alone. The store (`polis-store`), the embedders (`polis-embed`), the model
//! backends (`polis-llm`) and the transports (`polis-server`, `polis-mcp`) all
//! depend on this crate; it depends on none of them.
//!
//! Lifted from Redline in Session A1 of the Polis extraction — the moved code
//! is byte-for-byte what Redline ran, and Redline now re-exports it from its
//! old module paths (`docs/polis-extraction.md` in the Redline repo).

pub mod api;
pub mod bundle;
pub mod coldness;
pub mod dedup;
pub mod gist;
pub mod json;
pub mod ledger;
pub mod pack;
pub mod proposal;
pub mod query;
pub mod types;
pub mod vec;

pub use api::{MemoryApi, MemoryError, Scope};

#[cfg(test)]
mod guards {
    /// The crate must stay I/O-free: the manifest names exactly the three
    /// vocabulary dependencies. A `rusqlite`, `tokio`, `axum`, `reqwest` or
    /// platform crate here would drag the whole stack into every consumer.
    #[test]
    fn manifest_names_only_the_vocabulary_deps() {
        let manifest = include_str!("../Cargo.toml");
        let deps: Vec<&str> = manifest
            .split("[dependencies]")
            .nth(1)
            .expect("a [dependencies] table")
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
            .filter_map(|l| l.split('=').next())
            .map(str::trim)
            .collect();
        assert_eq!(deps, ["serde", "serde_json", "sha2"], "polis-core grew a dependency");
    }

    /// No module reaches for a database, a socket or a process. Pure means
    /// pure; the store is a different crate.
    #[test]
    fn no_module_touches_io() {
        const SOURCES: &[(&str, &str)] = &[
            ("api.rs", include_str!("api.rs")),
            ("bundle.rs", include_str!("bundle.rs")),
            ("coldness.rs", include_str!("coldness.rs")),
            ("dedup.rs", include_str!("dedup.rs")),
            ("gist.rs", include_str!("gist.rs")),
            ("json.rs", include_str!("json.rs")),
            ("ledger.rs", include_str!("ledger.rs")),
            ("pack.rs", include_str!("pack.rs")),
            ("proposal.rs", include_str!("proposal.rs")),
            ("query.rs", include_str!("query.rs")),
            ("types.rs", include_str!("types.rs")),
            ("vec.rs", include_str!("vec.rs")),
        ];
        for (name, src) in SOURCES {
            for banned in ["rusqlite", "std::fs", "std::net", "std::process", "tokio", "reqwest"] {
                assert!(!src.contains(banned), "{name} names `{banned}` — polis-core is I/O-free");
            }
        }
    }
}

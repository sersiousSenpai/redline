// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Text embeddings for memory's semantic arm — the provider, the chunker, and
//! the int8 vector arithmetic. No database, no retrieval policy; `db.rs` owns
//! the derived index and `context.rs` owns the fusion.
//!
//! ## Why there is an embedding model here at all
//!
//! The design law said "no embedding model enters the product". That law is
//! retired, and the reason it existed is worth keeping straight: its concerns
//! were **binary size** and **auditability**, and "no model" was a proxy for
//! both. Both are now met directly.
//!
//! - Size: `NLContextualEmbedding` is an **OS service**. Zero model bytes ship
//!   in the binary, the assets are managed by macOS, and inference runs on the
//!   Neural Engine. The framework crate is a declaration layer plus a
//!   `-framework` link directive.
//! - Auditability: every hit in the answer pack is labelled with the ARM that
//!   found it, so a semantic association can never be mistaken for a curated
//!   fact. `Semantic`-only hits are *associated*; `Node` hits are *curated*.
//!
//! What survives untouched is the law that actually mattered: **a ranked fuzzy
//! index must not become the taxonomy.** The arms decide what you read; the
//! tree decides what things are. Three guard tests in `context.rs` enforce it.
//!
//! ## Ship this last, and be clear-eyed about the bet
//!
//! After the corpus work the searchable user text is ~208 KB across ~658 rows,
//! and porter + prefix + trigram reach most of it. The semantic arm's real
//! payoff is browse text (2.3 MB / ~2,300 chunks) and the corpus two years from
//! now. If anything in this program gets cut, cut this.

use std::sync::Arc;

// The semantic arm is `polis-embed` (Session A3 of the Polis extraction);
// the pure vocabulary is `polis_core::vec`. Both re-exported so every
// `crate::embed::…` path resolves unchanged.
#[allow(unused_imports)]
pub use polis_core::vec::{
    chunk_text, cosine, pack, quantize, unpack, Chunk, QVec, CHUNK_MAX, CHUNK_OVERLAP, CHUNK_TARGET,
    DIM, OPENING_CHARS,
};
#[allow(unused_imports)]
pub use polis_embed::{
    cache, provider, provider_kind, Embedder, ProviderKind, SemanticHit, VectorCache,
    BRUTE_FORCE_CEILING_CHUNKS,
};

// What stays in the host: provider SELECTION. The cloud opt-in is a Redline
// setting (`app_settings`), the request rides Redline's reqwest on Redline's
// tokio runtime, and `provider_for` is the one place that decides. The two
// wrappers below keep the signatures every caller in this crate uses and hand
// the chosen embedder to `polis_embed`.

/// `app_settings` keys for the cloud opt-in. Off unless the user sets both.
pub const SETTING_EMBED_PROVIDER: &str = "redline.memory.embedProvider";
pub const SETTING_EMBED_KEY: &str = "redline.memory.embedKey";

/// A cloud embedding provider, opt-in and off by default.
///
/// Mirrors `tts.rs`'s premium engines exactly, including the part that matters
/// most: **the call is made from Rust, so the key never enters the webview**
/// and there is no browser CORS surface. The user's own prompt text leaves the
/// machine when this is on, which is why it is a deliberate switch with the
/// consequence stated in plain words beside it rather than a quality default.
///
/// The trait is the whole point of the design decision here: choosing cloud is
/// a SETTING, not a rewrite.
pub struct CloudEmbedder {
    key: String,
    model: String,
    http: reqwest::Client,
}

impl CloudEmbedder {
    /// `openai/<model>` is the only shape today; the setting is stored as a
    /// provider id so a second vendor is a match arm, not a schema change.
    pub fn from_settings(db: &crate::db::Database) -> Option<Self> {
        let provider = db.get_setting(SETTING_EMBED_PROVIDER)?;
        let provider = provider.trim();
        if provider.is_empty() || provider == "local" {
            return None;
        }
        let key = db
            .get_setting(SETTING_EMBED_KEY)
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())?;
        let model = match provider {
            "openai" => "text-embedding-3-small".to_string(),
            other => other.to_string(),
        };
        Some(Self { key, model, http: reqwest::Client::new() })
    }
}

impl Embedder for CloudEmbedder {
    fn model_id(&self) -> String {
        format!("openai-{}", self.model)
    }
    fn dim(&self) -> usize {
        // Requested explicitly below, so the stored dimension matches the
        // on-device providers' and one index can hold either.
        DIM
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        // `reqwest::blocking` is deliberately absent from this crate's feature
        // set (a size lever — see Cargo.toml), so the async client is driven
        // from the blocking worker this always runs on.
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cloud embedding needs a tokio runtime".to_string())?;
        let body = serde_json::json!({
            "model": self.model,
            "input": texts,
            "dimensions": DIM,
        });
        let req = self
            .http
            .post("https://api.openai.com/v1/embeddings")
            .bearer_auth(&self.key)
            .json(&body);
        let resp = handle
            .block_on(async { req.send().await })
            .map_err(|e| format!("embedding request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = handle.block_on(async { resp.text().await }).unwrap_or_default();
            let snippet: String = text.chars().take(300).collect();
            return Err(format!("embedding error {status}: {snippet}"));
        }
        let v: serde_json::Value = handle
            .block_on(async { resp.json().await })
            .map_err(|e| format!("embedding response was not JSON: {e}"))?;
        let data = v
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or("embedding response had no `data`")?;
        Ok(data
            .iter()
            .map(|row| {
                row.get("embedding")
                    .and_then(|e| e.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
                    .unwrap_or_default()
            })
            .collect())
    }
}

/// The provider for a given database: the cloud one when the user opted in,
/// otherwise the best on-device one. Not memoized on the settings path — a
/// user who pastes a key expects the next tick to use it.
pub fn provider_for(db: &crate::db::Database) -> Option<Arc<dyn Embedder>> {
    if let Some(c) = CloudEmbedder::from_settings(db) {
        return Some(Arc::new(c));
    }
    provider()
}

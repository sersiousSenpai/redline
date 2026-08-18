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

use std::sync::{Arc, OnceLock, RwLock};

/// Target characters per chunk. Small on purpose: `NLContextualEmbedding` caps
/// at 256 tokens, and a chunk that overflows the cap is silently truncated
/// rather than rejected — the failure mode is a vector that quietly describes
/// only the opening of the text.
pub const CHUNK_TARGET: usize = 800;
/// Hard ceiling before a hard cut.
pub const CHUNK_MAX: usize = 1_200;
/// Overlap between adjacent chunks, so a sentence spanning a boundary is whole
/// in at least one of them.
pub const CHUNK_OVERLAP: usize = 150;
/// Chunk 0 is ALWAYS the opening of the text, whatever the paragraph structure
/// says. Same insight as `fts_head`: a 6 KB prompt states its ask in its first
/// paragraph, and without a dedicated chunk for it that question is diluted
/// across a mean-pooled vector of the whole thing.
pub const OPENING_CHARS: usize = 400;

/// The dimensionality both Apple providers return.
pub const DIM: usize = 512;

// ---------------------------------------------------------------------------
// Chunking (pure)
// ---------------------------------------------------------------------------

/// One chunk of a source text, with the offsets it came from so a hit can be
/// highlighted back on the original.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub ix: i64,
    pub char_start: i64,
    pub char_len: i64,
    pub text: String,
}

/// Split text into embeddable chunks: paragraph boundaries first, then
/// sentences, then a hard cut. Never splits a fenced code block that fits.
pub fn chunk_text(text: &str) -> Vec<Chunk> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();

    // Chunk 0: the opening, always.
    let opening_len = OPENING_CHARS.min(chars.len());
    out.push(Chunk {
        ix: 0,
        char_start: 0,
        char_len: opening_len as i64,
        text: chars[..opening_len].iter().collect(),
    });
    if chars.len() <= OPENING_CHARS {
        return out;
    }

    let mut start = 0usize;
    while start < chars.len() {
        let hard_end = (start + CHUNK_MAX).min(chars.len());
        let target_end = (start + CHUNK_TARGET).min(chars.len());
        let end = if hard_end == chars.len() {
            chars.len()
        } else {
            // Prefer a paragraph break, then a sentence end, then the hard cut.
            // A fenced block that fits is never split: if the window opens a
            // fence and closes it before `hard_end`, cut after the close.
            find_break(&chars, start, target_end, hard_end)
        };
        let slice: String = chars[start..end].iter().collect();
        if !slice.trim().is_empty() {
            out.push(Chunk {
                ix: out.len() as i64,
                char_start: start as i64,
                char_len: (end - start) as i64,
                text: slice,
            });
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP).max(start + 1);
    }
    out
}

/// Choose a cut point in `[target, hard]`, preferring structure over position.
fn find_break(chars: &[char], start: usize, target: usize, hard: usize) -> usize {
    // A fence that opens inside this window and closes before the hard cut
    // takes precedence — splitting a code block produces two useless vectors.
    let window: String = chars[start..hard].iter().collect();
    if let Some(open) = window.find("```") {
        if let Some(close) = window[open + 3..].find("```") {
            let after = start + open + 3 + close + 3;
            if after > target && after <= hard {
                return after;
            }
        }
    }
    // Paragraph break at or after the target.
    for i in target..hard.saturating_sub(1) {
        if chars[i] == '\n' && chars[i + 1] == '\n' {
            return i + 2;
        }
    }
    // Sentence end.
    for i in target..hard {
        if matches!(chars[i], '.' | '!' | '?')
            && chars.get(i + 1).is_none_or(|c| c.is_whitespace())
        {
            return i + 1;
        }
    }
    hard
}

// ---------------------------------------------------------------------------
// int8 vectors
// ---------------------------------------------------------------------------

/// A quantized, L2-normalized embedding.
///
/// **int8, not f32**, and the arithmetic is the reason: recall loss is under 1%
/// at 512 dimensions while the storage drops from 2 KB to 516 B per chunk —
/// today's ~3,000 chunks are 1.6 MB instead of 6.3 MB. On a derived index that
/// can be rebuilt at any time, that is a free trade.
#[derive(Debug, Clone, PartialEq)]
pub struct QVec {
    pub scale: f32,
    pub bytes: Vec<i8>,
}

/// L2-normalize then quantize to int8 with a per-vector scale.
pub fn quantize(v: &[f32]) -> QVec {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    let inv = if norm > f32::EPSILON { 1.0 / norm } else { 0.0 };
    let unit: Vec<f32> = v.iter().map(|x| x * inv).collect();
    let peak = unit.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    let scale = if peak > f32::EPSILON { peak / 127.0 } else { 1.0 };
    QVec {
        scale,
        bytes: unit
            .iter()
            .map(|x| (x / scale).round().clamp(-127.0, 127.0) as i8)
            .collect(),
    }
}

/// Cosine similarity between two quantized vectors.
///
/// Both were unit-normalized before quantization, so the dot product IS the
/// cosine; the per-vector scales fold back in as one multiply at the end. The
/// inner loop is `i8 → i32`, which is what keeps brute force viable.
pub fn cosine(a: &QVec, b: &QVec) -> f32 {
    if a.bytes.len() != b.bytes.len() {
        return 0.0;
    }
    let dot: i32 = a
        .bytes
        .iter()
        .zip(b.bytes.iter())
        .map(|(x, y)| *x as i32 * *y as i32)
        .sum();
    dot as f32 * a.scale * b.scale
}

/// Pack a quantized vector for storage as a BLOB.
pub fn pack(q: &QVec) -> Vec<u8> {
    q.bytes.iter().map(|b| *b as u8).collect()
}

/// Unpack a stored BLOB.
pub fn unpack(blob: &[u8], scale: f32) -> QVec {
    QVec {
        scale,
        bytes: blob.iter().map(|b| *b as i8).collect(),
    }
}

/// The chunk count at which brute-force scan stops fitting a 50 ms budget.
///
/// **Write the number down so nobody re-litigates it from intuition.** Today:
/// 3,073 chunks × 512 dims = 1.57 M multiply-accumulates per query, well under
/// 1 ms in scalar Rust on `i8 → i32`. Linear in chunk count, so the crossover
/// is around **150,000 chunks**; at the observed ingest rate (~27k chunks/year)
/// that is about five years away. Until then an ANN index would be a structure
/// to maintain, invalidate and debug in exchange for nothing.
///
/// This is where `retrace`'s judgment explicitly does NOT transfer. It
/// concluded "loads ALL vectors into memory, O(N) per query" and excluded its
/// own vector search from the build — correctly, for a corpus of MILLIONS of
/// screen frames. Same algorithm, three orders of magnitude smaller regime,
/// opposite answer.
pub const BRUTE_FORCE_CEILING_CHUNKS: usize = 150_000;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/// A text-embedding backend. Behind a trait so the default is a SETTING rather
/// than a rewrite — a user who wants cloud quality flips a switch, and a user
/// who wants nothing to leave the machine keeps the default.
pub trait Embedder: Send + Sync {
    /// Stable identifier stored on every row, so a model change is a clean
    /// re-index rather than a migration.
    fn model_id(&self) -> String;
    fn dim(&self) -> usize;
    /// Embed a batch. Returns one vector per input, in order.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;
}

/// Which provider is configured, including the honest third state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// Apple's contextual embeddings (macOS 14+).
    AppleContextual,
    /// Apple's sentence embeddings (macOS 11+) — the 11–13 fallback.
    AppleSentence,
    /// No provider available. The arm is ABSENT, not empty: the answer pack
    /// says so via `armCoverage` rather than returning nothing and letting the
    /// reader conclude the record is empty.
    Absent,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::AppleContextual => "apple-contextual",
            ProviderKind::AppleSentence => "apple-sentence",
            ProviderKind::Absent => "absent",
        }
    }
}

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

/// Resolve the best available on-device provider, once per process.
///
/// `tauri.conf.json` pins `minimumSystemVersion: "11.0"` while
/// `NLContextualEmbedding` is macOS 14+, so the availability check is not
/// optional — it is the difference between working on the app's stated floor
/// and crashing on it. The three states are tried in quality order.
pub fn provider() -> Option<Arc<dyn Embedder>> {
    static P: OnceLock<Option<Arc<dyn Embedder>>> = OnceLock::new();
    P.get_or_init(build_provider).clone()
}

pub fn provider_kind() -> ProviderKind {
    provider().map(|p| p.kind()).unwrap_or(ProviderKind::Absent)
}

impl dyn Embedder {
    fn kind(&self) -> ProviderKind {
        match self.model_id().as_str() {
            m if m.starts_with("apple-contextual") => ProviderKind::AppleContextual,
            m if m.starts_with("apple-sentence") => ProviderKind::AppleSentence,
            _ => ProviderKind::Absent,
        }
    }
}

#[cfg(target_os = "macos")]
fn build_provider() -> Option<Arc<dyn Embedder>> {
    if let Some(e) = apple::ContextualEmbedder::available() {
        return Some(Arc::new(e));
    }
    if let Some(e) = apple::SentenceEmbedder::available() {
        return Some(Arc::new(e));
    }
    tracing::info!("no on-device embedding provider — the semantic arm is absent");
    None
}

#[cfg(not(target_os = "macos"))]
fn build_provider() -> Option<Arc<dyn Embedder>> {
    None
}

#[cfg(target_os = "macos")]
mod apple {
    use super::{Embedder, DIM};
    use std::sync::Mutex;
    use objc2_foundation::{NSRange, NSString};
    use objc2_natural_language::{NLContextualEmbedding, NLEmbedding, NLLanguage};

    /// The language every embedding is requested for. Apple's models are
    /// per-language and the corpus is a developer's prompts and English-language
    /// pages; a language-detection pass would be a second model to be wrong.
    fn english() -> Option<&'static NLLanguage> {
        unsafe { objc2_natural_language::NLLanguageEnglish }
    }

    /// `NLContextualEmbedding` — a transformer, 512-dim, 256-token cap,
    /// per-token vectors we mean-pool. macOS 14+.
    ///
    /// The handle lives inside a `Mutex` and the `Send`/`Sync` claim rests on
    /// that, not on a comment. An earlier version asserted "only ever used one
    /// call at a time" as a convention and shared the raw `Retained` across
    /// threads; concurrent inference on one instance aborted the process
    /// (SIGABRT), which is what an unenforced safety comment buys you. The
    /// mutex makes the serialization real, and inference is a `spawn_blocking`
    /// job anyway — there is no throughput being given up.
    pub struct ContextualEmbedder {
        inner: Mutex<objc2::rc::Retained<NLContextualEmbedding>>,
        revision: usize,
        dim: usize,
    }

    // SAFETY: every use goes through `inner.lock()`, so at most one thread
    // touches the ObjC object at a time. `NLContextualEmbedding` is a
    // compute object with no main-thread affinity (not a UI class).
    unsafe impl Send for ContextualEmbedder {}
    unsafe impl Sync for ContextualEmbedder {}

    impl ContextualEmbedder {
        pub fn available() -> Option<Self> {
            let lang = english()?;
            let inner = unsafe { NLContextualEmbedding::contextualEmbeddingWithLanguage(lang) }?;
            // Assets are OS-managed but not necessarily PRESENT. Loading a model
            // whose assets have not been downloaded fails; we do not trigger a
            // download here — a background asset fetch is not something a
            // retrieval path should start on the user's behalf.
            if !unsafe { inner.hasAvailableAssets() } {
                tracing::info!("contextual embedding assets are not downloaded yet");
                return None;
            }
            if let Err(e) = unsafe { inner.loadWithError() } {
                tracing::info!(error = ?e, "contextual embedding model failed to load");
                return None;
            }
            let revision = unsafe { inner.revision() };
            let dim = unsafe { inner.dimension() };
            Some(Self { inner: Mutex::new(inner), revision, dim })
        }
    }

    impl Embedder for ContextualEmbedder {
        fn model_id(&self) -> String {
            format!("apple-contextual-en-r{}", self.revision)
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
            let lang = english().ok_or("NLLanguageEnglish unavailable")?;
            let inner = self.inner.lock().map_err(|_| "embedder mutex poisoned")?;
            let mut out = Vec::with_capacity(texts.len());
            for t in texts {
                let ns = NSString::from_str(t);
                let result = unsafe {
                    inner.embeddingResultForString_language_error(&ns, Some(lang))
                }
                .map_err(|e| format!("embedding failed: {e:?}"))?;
                let len = unsafe { result.sequenceLength() };
                let dim = self.dim();
                // Mean-pool the per-token vectors. The block is called once per
                // token; `sum`/`count` accumulate across the enumeration.
                let acc = std::cell::RefCell::new(vec![0f64; dim]);
                let count = std::cell::Cell::new(0usize);
                let block = block2::RcBlock::new(
                    |vec: std::ptr::NonNull<objc2_foundation::NSArray<objc2_foundation::NSNumber>>,
                     _range: NSRange,
                     _stop: std::ptr::NonNull<objc2::runtime::Bool>| {
                        let vec = unsafe { vec.as_ref() };
                        let mut acc = acc.borrow_mut();
                        let n_vals = vec.len();
                        for (i, slot) in acc.iter_mut().enumerate().take(dim.min(n_vals)) {
                            *slot += vec.objectAtIndex(i).as_f64();
                        }
                        count.set(count.get() + 1);
                    },
                );
                unsafe {
                    result.enumerateTokenVectorsInRange_usingBlock(
                        NSRange::new(0, len),
                        &block,
                    );
                }
                let n = count.get().max(1) as f64;
                out.push(acc.borrow().iter().map(|x| (*x / n) as f32).collect());
            }
            Ok(out)
        }
    }

    /// `NLEmbedding.sentenceEmbedding` — macOS 11+, also 512-dim, one vector per
    /// string. Weaker than the contextual model (it is closer to a pooled word
    /// embedding), which is why it is the fallback rather than the default; it
    /// exists because the app's pinned `minimumSystemVersion` is 11.0 and an
    /// arm that only works on 14+ would be an arm most installs never see.
    pub struct SentenceEmbedder {
        inner: Mutex<objc2::rc::Retained<NLEmbedding>>,
        dim: usize,
    }

    // SAFETY: as `ContextualEmbedder` — serialized by the mutex it holds.
    unsafe impl Send for SentenceEmbedder {}
    unsafe impl Sync for SentenceEmbedder {}

    impl SentenceEmbedder {
        pub fn available() -> Option<Self> {
            let lang = english()?;
            let inner = unsafe { NLEmbedding::sentenceEmbeddingForLanguage(lang) }?;
            let dim = unsafe { inner.dimension() };
            Some(Self {
                inner: Mutex::new(inner),
                dim: if dim == 0 { DIM } else { dim },
            })
        }
    }

    impl Embedder for SentenceEmbedder {
        fn model_id(&self) -> String {
            "apple-sentence-en".to_string()
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
            let inner = self.inner.lock().map_err(|_| "embedder mutex poisoned")?;
            let mut out = Vec::with_capacity(texts.len());
            for t in texts {
                let ns = NSString::from_str(t);
                let v = unsafe { inner.vectorForString(&ns) };
                out.push(match v {
                    Some(arr) => (0..arr.len()).map(|i| arr.objectAtIndex(i).as_f64() as f32).collect(),
                    // A string the model has no vector for is a zero vector,
                    // which scores 0 against everything — honest, and never a
                    // spurious match.
                    None => vec![0.0; self.dim()],
                });
            }
            Ok(out)
        }
    }
}

// ---------------------------------------------------------------------------
// Hot vector cache
// ---------------------------------------------------------------------------

/// Every stored vector, kept resident and keyed on the index's high-water mark.
/// Mirrors `context::build_stats_cached`: cheap to rebuild, invalidated by a
/// single monotonic number rather than by anyone remembering to clear it.
pub struct VectorCache {
    pub head_id: i64,
    pub rows: Vec<(i64, String, i64, QVec)>,
}

pub fn cache() -> &'static RwLock<Option<Arc<VectorCache>>> {
    static C: OnceLock<RwLock<Option<Arc<VectorCache>>>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(None))
}

/// One semantic hit: what it points at, and how similar.
#[derive(Debug, Clone, PartialEq)]
pub struct SemanticHit {
    pub target_kind: String,
    pub target_id: i64,
    pub score: f32,
}

/// Nearest targets to `query` by cosine, best first.
///
/// Brute force over every vector, deliberately — see
/// [`BRUTE_FORCE_CEILING_CHUNKS`] for the number that makes that defensible and
/// the year it stops being. Chunks are collapsed to their target by MAX, so a
/// long document does not out-rank a short one by having more chances.
///
/// Returns `None` when no provider is configured. That is a THIRD state,
/// distinct from "no matches": the caller reports the arm as absent rather than
/// letting an empty list read as "you never thought about this".
pub fn semantic_search(
    db: &crate::db::Database,
    query: &str,
    limit: usize,
) -> Option<Vec<SemanticHit>> {
    let provider = provider_for(db)?;
    let model = provider.model_id();
    let qvec = provider.embed(&[query.to_string()]).ok()?.into_iter().next()?;
    let q = quantize(&qvec);

    let head = db.max_embedding_id().unwrap_or(0);
    if head == 0 {
        // The index exists but is empty — still "absent", not "no matches".
        return None;
    }
    // Hot cache keyed on the index head, mirroring `build_stats_cached`.
    let cached = {
        let guard = cache().read().ok()?;
        guard.as_ref().filter(|c| c.head_id == head).cloned()
    };
    let vectors = match cached {
        Some(c) => c,
        None => {
            let rows = db.all_embeddings(&model).ok()?;
            let fresh = Arc::new(VectorCache { head_id: head, rows });
            if let Ok(mut guard) = cache().write() {
                *guard = Some(fresh.clone());
            }
            fresh
        }
    };

    // The crossover, checked rather than assumed. Brute force is correct here
    // and stops being correct at a specific size; saying so once, when it
    // happens, beats a comment nobody re-reads.
    if vectors.rows.len() > BRUTE_FORCE_CEILING_CHUNKS {
        tracing::warn!(
            chunks = vectors.rows.len(),
            ceiling = BRUTE_FORCE_CEILING_CHUNKS,
            "the vector index has outgrown a brute-force scan — an ANN index is now worth its \
             maintenance cost (see BRUTE_FORCE_CEILING_CHUNKS)"
        );
    }
    let mut best: std::collections::HashMap<(String, i64), f32> = std::collections::HashMap::new();
    for (_, kind, id, v) in &vectors.rows {
        let s = cosine(&q, v);
        let e = best.entry((kind.clone(), *id)).or_insert(f32::MIN);
        if s > *e {
            *e = s;
        }
    }
    let mut hits: Vec<SemanticHit> = best
        .into_iter()
        .map(|((target_kind, target_id), score)| SemanticHit { target_kind, target_id, score })
        .collect();
    // Deterministic order: score desc, then target for ties.
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.target_kind.cmp(&b.target_kind))
            .then_with(|| a.target_id.cmp(&b.target_id))
    });
    hits.truncate(limit);
    Some(hits)
}

/// Embed one tick's worth of backlog. Best-effort and bounded: a retrieval
/// index is never allowed to become a reason the app is busy.
pub fn index_tick(db: &crate::db::Database, max_targets: usize) -> usize {
    let Some(provider) = provider_for(db) else { return 0 };
    let model = provider.model_id();
    let Ok(backlog) = db.embedding_backlog(&model, max_targets as i64) else {
        return 0;
    };
    let mut done = 0usize;
    for (kind, id, text, hash) in backlog {
        let chunks = chunk_text(&text);
        if chunks.is_empty() {
            continue;
        }
        let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
        let Ok(vectors) = provider.embed(&texts) else { continue };
        let rows: Vec<(Chunk, QVec)> = chunks
            .into_iter()
            .zip(vectors.into_iter().map(|v| quantize(&v)))
            .collect();
        if let Err(e) = db.store_embeddings(&kind, id, &model, &hash, &rows) {
            tracing::warn!(error = %e, kind, id, "failed to store embeddings");
            continue;
        }
        done += 1;
    }
    if done > 0 {
        // The head moved; the next search rebuilds the cache from its key.
        if let Ok(mut guard) = cache().write() {
            *guard = None;
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_zero_is_always_the_opening() {
        let text = format!("THE ASK: what did I decide?\n\n{}", "filler ".repeat(500));
        let chunks = chunk_text(&text);
        assert_eq!(chunks[0].ix, 0);
        assert_eq!(chunks[0].char_start, 0);
        assert!(chunks[0].text.starts_with("THE ASK"));
        assert_eq!(chunks[0].char_len, OPENING_CHARS as i64);
        // …and it does not consume the rest: the body is chunked too.
        assert!(chunks.len() > 1);
    }

    #[test]
    fn short_text_is_one_chunk_with_no_padding() {
        let chunks = chunk_text("a short prompt");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "a short prompt");
        assert_eq!(chunks[0].char_len, 14);
        assert!(chunk_text("").is_empty());
    }

    #[test]
    fn chunks_overlap_and_stay_under_the_ceiling() {
        let text: String = (0..400).map(|i| format!("sentence number {i}. ")).collect();
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 3);
        for c in &chunks {
            assert!(
                c.char_len <= CHUNK_MAX as i64,
                "chunk {} is {} chars",
                c.ix,
                c.char_len
            );
        }
        // Body chunks (past the opening) overlap their predecessor.
        for w in chunks[1..].windows(2) {
            let prev_end = w[0].char_start + w[0].char_len;
            assert!(w[1].char_start < prev_end, "chunks must overlap");
        }
    }

    /// A fenced block that fits is never split — two halves of a code block
    /// embed to two vectors that describe neither.
    #[test]
    fn a_fenced_block_that_fits_is_kept_whole() {
        let pre = "x".repeat(700);
        let code = format!("```rust\n{}\n```", "let x = 1;\n".repeat(20));
        let text = format!("{pre}\n\n{code}\n\ntrailing prose {}", "y".repeat(600));
        let chunks = chunk_text(&text);
        let holding = chunks
            .iter()
            .skip(1)
            .find(|c| c.text.contains("```rust"))
            .expect("some chunk opens the fence");
        assert!(
            holding.text.matches("```").count() >= 2,
            "the chunk that opens a fence must also close it:\n{}",
            holding.text
        );
    }

    #[test]
    fn quantization_round_trips_within_tolerance() {
        let v: Vec<f32> = (0..DIM).map(|i| ((i as f32) * 0.017).sin()).collect();
        let q = quantize(&v);
        assert_eq!(q.bytes.len(), DIM);
        // A vector is maximally similar to itself.
        assert!((cosine(&q, &q) - 1.0).abs() < 0.02, "self-cosine {}", cosine(&q, &q));
        // Storage: one byte per dimension plus the scale.
        assert_eq!(pack(&q).len(), DIM);
        assert_eq!(unpack(&pack(&q), q.scale), q);
    }

    #[test]
    fn cosine_orders_similar_above_dissimilar() {
        let a: Vec<f32> = (0..DIM).map(|i| (i as f32 * 0.01).sin()).collect();
        // `b` is `a` with noise; `c` is unrelated.
        let b: Vec<f32> = a.iter().enumerate().map(|(i, x)| x + (i as f32 * 0.3).cos() * 0.05).collect();
        let c: Vec<f32> = (0..DIM).map(|i| (i as f32 * 0.31).cos()).collect();
        let (qa, qb, qc) = (quantize(&a), quantize(&b), quantize(&c));
        assert!(
            cosine(&qa, &qb) > cosine(&qa, &qc),
            "near {} vs far {}",
            cosine(&qa, &qb),
            cosine(&qa, &qc)
        );
        // Mismatched dimensions score zero rather than panicking.
        assert_eq!(cosine(&qa, &quantize(&[1.0, 2.0])), 0.0);
    }

    /// The crossover number, asserted so a future reader finds it as a fact
    /// rather than re-deriving it from intuition.
    #[test]
    fn brute_force_stays_viable_for_years_at_the_observed_rate() {
        const CHUNKS_TODAY: usize = 3_073;
        const CHUNKS_PER_YEAR: usize = 27_000;
        assert!(CHUNKS_TODAY < BRUTE_FORCE_CEILING_CHUNKS / 40);
        let years = (BRUTE_FORCE_CEILING_CHUNKS - CHUNKS_TODAY) / CHUNKS_PER_YEAR;
        assert!(years >= 5, "only {years} years of headroom — time to reconsider ANN");
    }
}

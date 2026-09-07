// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `polis-memory` — the crate an integrator adds.
//!
//! [`Polis`] is a borrowed view over the four things memory needs: the store,
//! an optional model ([`polis_llm::Agent`]), the host's answers
//! ([`polis_core::host::HostResolver`]) and where a turn's cost goes
//! ([`polis_llm::UsageSink`]) — plus an optional embedder for the semantic
//! arm. Every function in this crate takes `&Polis<'_>`; a host builds one per
//! call from what it owns (Redline: `polis_host::polis_for(&db)`), and the
//! standalone daemon holds a [`PolisHandle`] (the same four, owned) that
//! implements [`polis_core::MemoryApi`] — the one surface the server, the
//! MCP server and the clients speak.
//!
//! What lives here, lifted from Redline in Session A5 of the Polis
//! extraction: the organizer ([`organize`]), the gardener's passes and gates
//! ([`gardener`]), retrieval ([`retrieval`]), export ([`bundle`]) and the
//! markdown mirror ([`mirror`]). The host keeps only what only a host has:
//! the watch bus, friction, its own tables, provider selection.

pub mod agent;
pub mod bundle;
pub mod gardener;
pub mod mirror;
pub mod organize;
pub mod retrieval;
pub mod skill;

use std::sync::Arc;

pub use polis_core;
pub use polis_embed;
pub use polis_llm;
pub use polis_store;

use polis_core::api::{
    AnnotateRequest, BoxFuture, BrowseRequest, CaptureRequest, ContextBlock, ContextRequest,
    ForgetReceipt, ForgetRequest, GrepRequest, HealthReport, IngestReceipt, IngestRequest,
    NodeView, OrganizeReceipt, PromptsRequest, ReindexReceipt, RememberRequest, Scope,
    SearchRequest, SupersedeReceipt, SupersedeRequest, TreeNodeView, TreeRequest, WriteReceipt,
};
use polis_core::host::HostResolver;
use polis_core::ledger::{ChainVerdict, CorpusRole, Origin, PromptSource};
use polis_core::pack::{clamp_answer_pack_limit, AnswerPack};
use polis_core::proposal::Proposal;
use polis_core::types::{
    BrowseHit, ContextStats, GrepHit, LakeItem, LedgerFilters, MemoryMapView, NoteOutcome,
    NoteWrite, PromptFilters, StageResult, SupersessionOutcome, TimelineItem,
};
use polis_core::{MemoryApi, MemoryError};
use polis_embed::{Embedder, ProviderKind, SemanticHit};
use polis_llm::{Agent, UsageSink};
use polis_store::record::{
    record_browse_event, record_prompt, record_prompt_at, BrowseAction, BrowseEventInput,
    PromptInput,
};
use polis_store::search::GrepError;
use polis_store::{PolisStore, StoreError};

/// The borrowed view every memory function takes.
pub struct Polis<'a> {
    pub store: &'a PolisStore,
    /// `None` is the no-model state (R12): the gardener runs its deterministic
    /// tiers and every model pass reports `no model configured`.
    pub agent: Option<Arc<dyn Agent>>,
    pub host: &'a dyn HostResolver,
    pub sink: &'a dyn UsageSink,
    /// The semantic arm's provider, when the host selected one. `None` means
    /// the arm is ABSENT (reported as such, never as empty).
    pub embedder: Option<Arc<dyn Embedder>>,
}

impl<'a> Polis<'a> {
    pub fn new(
        store: &'a PolisStore,
        agent: Option<Arc<dyn Agent>>,
        host: &'a dyn HostResolver,
        sink: &'a dyn UsageSink,
    ) -> Self {
        Self { store, agent, host, sink, embedder: None }
    }

    pub fn with_embedder(mut self, embedder: Option<Arc<dyn Embedder>>) -> Self {
        self.embedder = embedder;
        self
    }

    // --- the host seams, spelled the way the moved bodies call them ---------
    //
    // Each of these is where a `db.<method>` in Redline read a host table or a
    // host setting. The names are kept so the moved bodies read as they did;
    // the answer now comes from `polis_meta` or the `HostResolver`.

    /// A `polis.*` setting from `polis_meta` (was `app_settings`).
    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.store.meta(key).ok().flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.store.set_meta(key, value)
    }

    pub fn list_project_paths(&self) -> rusqlite::Result<Vec<String>> {
        Ok(self.host.project_roots())
    }

    pub fn thread_stats(&self, kind: &str, id: &str) -> Option<(i64, Option<i64>)> {
        self.host.thread_stats(kind, id)
    }

    pub fn thread_label(&self, kind: &str, id: &str) -> Option<String> {
        self.host.label(kind, id)
    }

    pub fn revision_markdown(&self, session: &str, version: i64) -> rusqlite::Result<Option<String>> {
        Ok(self.host.revision_markdown(session, version))
    }

    pub fn decision_event_context(&self, seq: i64) -> rusqlite::Result<Option<String>> {
        Ok(self.host.decision_evidence(seq))
    }

    /// Drop a queued proposal the verifier refuted. Redline also filed a
    /// friction row here; the B2 run journal (`class_run_ops`) is where a
    /// refusal is recorded from now on — until it lands, the log line is the
    /// trace.
    pub fn reject_class_proposal(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.store.conn();
        let op = PolisStore::delete_class_proposal(&conn, id)?;
        tracing::info!(proposal = id, op = op.as_deref().unwrap_or("?"), "proposal refuted by the verifier");
        Ok(())
    }

    /// The Timeline page: the store's rows, with the host's own pictures
    /// joined on (`surface_shots` is a host table).
    pub fn query_ledger_events(&self, f: &LedgerFilters) -> rusqlite::Result<Vec<TimelineItem>> {
        let mut items = self.store.query_ledger_events(f)?;
        if !items.is_empty() {
            let seqs: Vec<i64> = items.iter().map(|it| it.event.seq).collect();
            for (seq, key) in self.host.surface_shot_keys(&seqs) {
                if let Some(it) = items.iter_mut().find(|it| it.event.seq == seq) {
                    it.shot_key = Some(key);
                }
            }
        }
        Ok(items)
    }

    /// Which provider backs the semantic arm — the honest third state
    /// (`Absent`) when none does.
    pub fn provider_kind(&self) -> ProviderKind {
        self.embedder.as_deref().map(|e| e.kind()).unwrap_or(ProviderKind::Absent)
    }
}

/// Nearest targets to `query` by cosine, or `None` when no embedder is
/// configured — the arm is absent, not empty.
pub fn semantic_search(polis: &Polis<'_>, query: &str, limit: usize) -> Option<Vec<SemanticHit>> {
    let embedder = polis.embedder.as_deref()?;
    polis_embed::semantic_search(polis.store, embedder, query, limit)
}

/// Embed one tick's worth of backlog; 0 when no embedder is configured.
pub fn index_tick(polis: &Polis<'_>, max_targets: usize) -> usize {
    match polis.embedder.as_deref() {
        Some(embedder) => polis_embed::index_tick(polis.store, embedder, max_targets),
        None => 0,
    }
}

// ---------------------------------------------------------------------------
// The owned handle
// ---------------------------------------------------------------------------

/// The same four things, owned — what a long-lived process (the daemon, the
/// MCP server, a host's app state) holds, and what implements [`MemoryApi`].
pub struct PolisHandle {
    pub store: Arc<PolisStore>,
    pub agent: Option<Arc<dyn Agent>>,
    pub host: Arc<dyn HostResolver>,
    pub sink: Arc<dyn UsageSink>,
    pub embedder: Option<Arc<dyn Embedder>>,
}

impl PolisHandle {
    pub fn new(store: Arc<PolisStore>, agent: Option<Arc<dyn Agent>>, host: Arc<dyn HostResolver>, sink: Arc<dyn UsageSink>) -> Self {
        Self { store, agent, host, sink, embedder: None }
    }

    pub fn with_embedder(mut self, embedder: Option<Arc<dyn Embedder>>) -> Self {
        self.embedder = embedder;
        self
    }

    /// The borrowed view every memory function takes.
    pub fn view(&self) -> Polis<'_> {
        Polis {
            store: &self.store,
            agent: self.agent.clone(),
            host: &*self.host,
            sink: &*self.sink,
            embedder: self.embedder.clone(),
        }
    }
}

fn store_err(e: rusqlite::Error) -> MemoryError {
    MemoryError::Store(e.to_string())
}

impl MemoryApi for PolisHandle {
    fn search(&self, req: &SearchRequest) -> Result<AnswerPack, MemoryError> {
        Ok(retrieval::build_answer_pack(
            &self.view(),
            req.q.as_deref(),
            req.node.as_deref(),
            clamp_answer_pack_limit(req.limit),
        ))
    }

    fn grep(&self, req: &GrepRequest) -> Result<Vec<GrepHit>, MemoryError> {
        let limit = req.limit.unwrap_or(20).clamp(1, 200);
        self.store
            .grep_memory(&req.literal, req.regex.as_deref(), req.case_sensitive, req.kinds, limit)
            .map_err(|e| match e {
                GrepError::Db(m) => MemoryError::Store(m),
                other => MemoryError::Rejected(other.to_string()),
            })
    }

    fn tree(&self, req: &TreeRequest) -> Result<Vec<TreeNodeView>, MemoryError> {
        retrieval::tree_view(&self.view(), req.root.as_deref(), req.project.as_deref()).map_err(store_err)
    }

    fn node(&self, id: &str, _scope: &Scope) -> Result<Option<NodeView>, MemoryError> {
        retrieval::node_view(&self.view(), id).map_err(store_err)
    }

    fn prompts(&self, req: &PromptsRequest) -> Result<Vec<LakeItem>, MemoryError> {
        let limit = req.limit.unwrap_or(200).clamp(1, 400);
        self.store.list_lake_items_since(req.since_seq, limit).map_err(store_err)
    }

    fn timeline(&self, filters: &LedgerFilters, _scope: &Scope) -> Result<Vec<TimelineItem>, MemoryError> {
        retrieval::query_ledger(&self.view(), filters).map_err(MemoryError::Store)
    }

    fn stats(&self, _scope: &Scope) -> Result<ContextStats, MemoryError> {
        Ok(retrieval::build_stats_cached(&self.view()))
    }

    fn map(&self, _scope: &Scope) -> Result<MemoryMapView, MemoryError> {
        Ok(retrieval::build_memory_map(&self.view()))
    }

    fn verify(&self) -> Result<ChainVerdict, MemoryError> {
        self.store.verify_ledger_chain().map_err(store_err)
    }

    fn list_prompts(&self, filters: &PromptFilters, _scope: &Scope) -> Result<Vec<LakeItem>, MemoryError> {
        retrieval::list_prompts(&self.view(), filters).map_err(MemoryError::Store)
    }

    fn browse_search(&self, q: &str, limit: i64, _scope: &Scope) -> Result<Vec<BrowseHit>, MemoryError> {
        self.store.search_browse_events(q, limit.clamp(1, 100)).map_err(store_err)
    }

    fn thread_tree(&self, kind: &str, id: &str, _scope: &Scope) -> Result<serde_json::Value, MemoryError> {
        Ok(retrieval::build_thread_tree(&self.view(), kind, id))
    }

    fn thread(&self, kind: &str, id: &str, limit: i64, _scope: &Scope) -> Result<Option<serde_json::Value>, MemoryError> {
        Ok(retrieval::thread_view(&self.view(), kind, id, limit.clamp(1, 200)))
    }

    fn context(&self, req: &ContextRequest) -> Result<ContextBlock, MemoryError> {
        // ~4 bytes a token; the prefetch's own ceiling bounds a runaway ask.
        let max_bytes = req.max_tokens.unwrap_or(2_000).clamp(50, 25_000) * 4;
        Ok(retrieval::context_block(&self.view(), &req.q, req.node.as_deref(), max_bytes))
    }

    fn health(&self) -> Result<HealthReport, MemoryError> {
        let view = self.view();
        let chain = self.store.verify_ledger_chain().map_err(store_err)?;
        let head_seq = self.store.max_ledger_seq().map_err(store_err)?;
        let class_nodes = self.store.list_class_nodes().map_err(store_err)?.len() as i64;
        // Counted directly, not through `build_stats_cached`: that cache is
        // process-global with a wall-clock floor, so two stores in one process
        // (two tests, or a daemon serving a fresh file) could read each
        // other's numbers. Health must be this store's.
        let total_prompts: i64 = self.store.prompt_counts_by_surface().map_err(store_err)?.iter().map(|(_, c)| c).sum();
        Ok(HealthReport {
            ok: chain.ok,
            chain,
            head_seq,
            total_prompts,
            class_nodes,
            model: self.agent.as_ref().map(|a| a.name().to_string()),
            embedder: view.provider_kind().as_str().to_string(),
            schema_version: view.get_setting(polis_store::meta::SCHEMA_VERSION_KEY),
            lexical_version: view.get_setting(polis_store::meta::LEXICAL_VERSION_KEY),
        })
    }

    fn capture(&self, req: &CaptureRequest) -> Result<Option<i64>, MemoryError> {
        // The hook's row, exactly as Redline's ingest route always built it
        // (`source: Hook`, the captured-text role classifier, no seat, no
        // model — the transcript backfill stamps that later).
        let input = PromptInput {
            source: PromptSource::Hook,
            origin: req.origin,
            surface: req.surface.clone(),
            role: CorpusRole::classify_captured(&req.body),
            user_text: None,
            session_id: None,
            claude_session_id: req.session.clone(),
            mission_id: None,
            project_path: req.project.clone(),
            body: req.body.clone(),
            thread: None,
            author: None,
            model: None,
            model_source: None,
        };
        record_prompt(&self.store, input).map_err(MemoryError::Store)
    }

    fn remember(&self, req: &RememberRequest) -> Result<WriteReceipt, MemoryError> {
        if req.text.trim().is_empty() {
            return Err(MemoryError::Rejected("nothing to remember".into()));
        }
        if req.as_user {
            let seq = record_prompt(
                &self.store,
                PromptInput {
                    source: PromptSource::Api,
                    origin: Origin::External,
                    surface: "api".to_string(),
                    role: CorpusRole::User,
                    session_id: None,
                    claude_session_id: None,
                    mission_id: None,
                    project_path: req.project.clone(),
                    body: req.text.clone(),
                    thread: None,
                    author: None,
                    model: None,
                    model_source: None,
                    user_text: None,
                },
            )
            .map_err(MemoryError::Store)?;
            return Ok(WriteReceipt { seq, id: None });
        }
        let write = NoteWrite { target_kind: Some("none".to_string()), text: Some(req.text.clone()), ..Default::default() };
        note_receipt(self.store.write_user_note(&write, self.store.author()).map_err(store_err)?)
    }

    fn ingest(&self, req: &IngestRequest) -> Result<IngestReceipt, MemoryError> {
        let mut receipt = IngestReceipt::default();
        for item in &req.items {
            if item.body.trim().is_empty() {
                receipt.skipped += 1;
                continue;
            }
            let role = match item.role.as_deref() {
                Some("agent") => CorpusRole::Agent,
                Some("system") => CorpusRole::System,
                _ => CorpusRole::User,
            };
            let input = PromptInput {
                source: PromptSource::Api,
                origin: Origin::External,
                surface: "import".to_string(),
                role,
                session_id: item.session.clone(),
                claude_session_id: item.run.clone(),
                mission_id: None,
                project_path: item.project.clone(),
                body: item.body.clone(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
                user_text: None,
            };
            let ts = item.ts.unwrap_or_else(polis_core::ledger::now_millis);
            match record_prompt_at(&self.store, input, ts).map_err(MemoryError::Store)? {
                Some(seq) => receipt.recorded.push(seq),
                None => receipt.skipped += 1, // dedup on (body_hash, run)
            }
        }
        Ok(receipt)
    }

    fn annotate(&self, req: &AnnotateRequest) -> Result<WriteReceipt, MemoryError> {
        let write = NoteWrite {
            target_kind: Some(req.target_kind.clone()),
            target_id: req.target_id.clone(),
            text: Some(req.text.clone()),
            ..Default::default()
        };
        note_receipt(self.store.write_user_note(&write, self.store.author()).map_err(store_err)?)
    }

    fn forget(&self, req: &ForgetRequest) -> Result<ForgetReceipt, MemoryError> {
        if req.confirm != "forget" {
            return Err(MemoryError::Rejected("forget requires confirm: \"forget\"".into()));
        }
        match req.target_kind.as_str() {
            "prompt" => {
                let id: i64 = req
                    .target_id
                    .trim()
                    .parse()
                    .map_err(|_| MemoryError::Rejected("target_id must be a prompt id".into()))?;
                let seq = self
                    .store
                    .compact_prompt_body(id, "[forgotten]", "forget", gardener::GIST_SOURCE_DETERMINISTIC, self.store.author())
                    .map_err(store_err)?;
                Ok(ForgetReceipt { forgotten: true, seq })
            }
            other => Err(MemoryError::Unavailable(format!("forget for `{other}` lands with the sharing layer (E2)"))),
        }
    }

    fn supersede(&self, req: &SupersedeRequest) -> Result<SupersedeReceipt, MemoryError> {
        match self
            .store
            .apply_supersession(req.old_seq, req.new_seq, req.rationale.as_deref().unwrap_or(""), self.store.author())
            .map_err(store_err)?
        {
            SupersessionOutcome::Applied { effective_old, new_seq: _, event_seq } => Ok(SupersedeReceipt {
                applied: true,
                effective_old: Some(effective_old),
                event_seq: Some(event_seq),
                rejected: None,
            }),
            SupersessionOutcome::Rejected(reason) => Ok(SupersedeReceipt {
                applied: false,
                effective_old: None,
                event_seq: None,
                rejected: Some(reason),
            }),
        }
    }

    fn stage_proposals(&self, proposals: &[Proposal], _actor: &str) -> Result<StageResult, MemoryError> {
        organize::stage_proposals(&self.view(), None, proposals).map_err(|e| MemoryError::Store(e.to_string()))
    }

    fn browse(&self, req: &BrowseRequest) -> Result<WriteReceipt, MemoryError> {
        if req.url.trim().is_empty() {
            return Err(MemoryError::Rejected("a browse event needs a url".into()));
        }
        let action = match req.action.as_deref().unwrap_or("navigate") {
            "navigate" => BrowseAction::Navigate,
            "select" => BrowseAction::Select,
            "submit" => BrowseAction::Submit,
            "leave" => BrowseAction::Leave,
            other => return Err(MemoryError::Rejected(format!("unknown browse action `{other}`"))),
        };
        let seq = record_browse_event(
            &self.store,
            BrowseEventInput {
                action,
                browse_id: req.browse_id.clone(),
                url: req.url.clone(),
                title: req.title.clone(),
                text: req.text.clone(),
                from_event_id: None,
                author: req.author.clone(),
            },
        )
        .map_err(MemoryError::Store)?;
        Ok(WriteReceipt { seq, id: None })
    }

    fn organize(&self, _scope: &Scope) -> BoxFuture<'_, Result<OrganizeReceipt, MemoryError>> {
        Box::pin(async move {
            let view = self.view();
            match organize::organize_once(&view).await {
                Ok(o) => Ok(OrganizeReceipt {
                    ran: o.ran,
                    auto_applied: o.auto_applied,
                    summary: o.summary,
                    seq_from: o.seq_from,
                    seq_to: o.seq_to,
                    staged: o.staged,
                }),
                Err(e) if e == agent::NO_MODEL => Err(MemoryError::Unavailable(e)),
                Err(e) => Err(MemoryError::Store(e)),
            }
        })
    }

    fn reindex(&self, _scope: &Scope) -> Result<ReindexReceipt, MemoryError> {
        let view = self.view();
        let provider = view.provider_kind().as_str().to_string();
        let embedded = index_tick(&view, REINDEX_MAX_TARGETS);
        Ok(ReindexReceipt { embedded, provider })
    }
}

/// How much of the semantic backlog one `reindex` call embeds. Bounded so a
/// route call is a bounded amount of work; a caller drains a large backlog by
/// calling again (the gardener's own tick keeps draining it regardless).
pub const REINDEX_MAX_TARGETS: usize = 256;

fn note_receipt(outcome: NoteOutcome) -> Result<WriteReceipt, MemoryError> {
    match outcome {
        NoteOutcome::Written(n) | NoteOutcome::Unchanged(n) => Ok(WriteReceipt { seq: n.seq, id: Some(n.id) }),
        NoteOutcome::Rejected(r) => Err(MemoryError::Rejected(r)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use polis_core::host::NoHost;
    use polis_llm::NoopSink;

    fn handle() -> PolisHandle {
        PolisHandle::new(Arc::new(PolisStore::open_in_memory().unwrap()), None, Arc::new(NoHost), Arc::new(NoopSink))
    }

    #[test]
    fn the_handle_serves_the_one_surface_over_an_empty_store() {
        let h = handle();
        let api: &dyn MemoryApi = &h;
        assert!(api.verify().unwrap().ok);
        assert!(api.tree(&TreeRequest::default()).unwrap().is_empty());
        assert_eq!(api.node("nope", &Scope::default()).unwrap().map(|_| ()), None);
        let pack = api.search(&SearchRequest { q: Some("anything".into()), ..Default::default() }).unwrap();
        assert!(pack.prompt_hits.is_empty());
        assert!(api.stats(&Scope::default()).unwrap().total_prompts == 0);
        assert!(api.map(&Scope::default()).unwrap().nodes.is_empty());
    }

    #[test]
    fn remember_and_ingest_write_through_the_chain_and_dedupe() {
        let h = handle();
        let api: &dyn MemoryApi = &h;
        let r = api.remember(&RememberRequest { text: "use postgres".into(), as_user: true, ..Default::default() }).unwrap();
        assert_eq!(r.seq, Some(1));
        let items = api.prompts(&PromptsRequest::default()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].role.as_deref(), Some("user"));

        let batch = IngestRequest {
            items: vec![
                polis_core::api::IngestItem { body: "hello".into(), ts: Some(1_000), run: Some("r1".into()), ..Default::default() },
                polis_core::api::IngestItem { body: "hello".into(), ts: Some(2_000), run: Some("r1".into()), ..Default::default() },
                polis_core::api::IngestItem { body: "  ".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let receipt = api.ingest(&batch).unwrap();
        assert_eq!(receipt.recorded, vec![2]);
        assert_eq!(receipt.skipped, 2, "the replay and the blank are skipped");
        assert!(api.verify().unwrap().ok);

        let note = api.remember(&RememberRequest { text: "a standalone thought".into(), as_user: false, ..Default::default() }).unwrap();
        assert!(note.id.is_some());
        assert!(api.forget(&ForgetRequest { target_kind: "prompt".into(), target_id: "1".into(), confirm: "nope".into(), ..Default::default() }).is_err());
        let f = api.forget(&ForgetRequest { target_kind: "prompt".into(), target_id: "1".into(), confirm: "forget".into(), ..Default::default() }).unwrap();
        assert!(f.forgotten);
        assert!(api.verify().unwrap().ok, "forget keeps the chain green");
    }

    /// The A6 additions: the hook's capture row, a browse event, the filtered
    /// reads, health in the no-model state, and a reindex with no embedder —
    /// every one answered, none an error.
    #[test]
    fn the_capture_browse_and_maintenance_methods_answer_over_an_empty_install() {
        let h = handle();
        let api: &dyn MemoryApi = &h;
        let seq = api
            .capture(&CaptureRequest {
                body: "captured by the hook".into(),
                origin: Origin::External,
                surface: "external".into(),
                session: Some("sess-1".into()),
                project: Some("/tmp/p".into()),
            })
            .unwrap();
        assert_eq!(seq, Some(1));
        let again = api
            .capture(&CaptureRequest {
                body: "captured by the hook".into(),
                origin: Origin::External,
                surface: "external".into(),
                session: Some("sess-1".into()),
                project: Some("/tmp/p".into()),
            })
            .unwrap();
        assert_eq!(again, None, "the store's own dedup");
        let items = api.list_prompts(&PromptFilters { limit: 10, ..Default::default() }, &Scope::default()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].surface.as_deref(), Some("external"));

        let b = api
            .browse(&BrowseRequest { url: "https://example.test/a".into(), text: "Example page".into(), title: Some("Example".into()), ..Default::default() })
            .unwrap();
        assert_eq!(b.seq, Some(2));
        assert!(api.browse(&BrowseRequest { url: "".into(), ..Default::default() }).is_err());
        assert!(api.browse(&BrowseRequest { url: "https://x".into(), action: Some("teleport".into()), ..Default::default() }).is_err());
        assert!(!api.browse_search("Example", 10, &Scope::default()).unwrap().is_empty());

        assert!(api.thread("browse", "nope", 10, &Scope::default()).unwrap().is_none(), "NoHost owns no threads");
        let tree = api.thread_tree("session", "s1", &Scope::default()).unwrap();
        assert_eq!(tree["node"]["kind"], "session");

        let health = api.health().unwrap();
        assert!(health.ok);
        assert_eq!(health.head_seq, 2);
        assert_eq!(health.model, None, "no model → reported, not an error");
        assert_eq!(health.embedder, "absent");
        assert_eq!(health.schema_version.as_deref(), Some(polis_store::meta::STORE_SCHEMA_VERSION));

        let r = api.reindex(&Scope::default()).unwrap();
        assert_eq!((r.embedded, r.provider.as_str()), (0, "absent"));

        let block = api.context(&ContextRequest { q: "captured hook".into(), ..Default::default() }).unwrap();
        assert!(!block.terms.is_empty(), "the plan names what it searched");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let o = rt.block_on(api.organize(&Scope::default()));
        assert!(matches!(o, Err(MemoryError::Unavailable(_))), "no model → unavailable, never a fault: {o:?}");
    }
}

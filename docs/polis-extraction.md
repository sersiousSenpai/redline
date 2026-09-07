# Polis extraction — the ledger of what moved

Redline's memory system (the hash-chained prompt/decision lake, the
agent-organized class catalog, batched retrieval over both) is becoming
**Polis Memory**: its own local-first product, reachable over MCP, that
Redline imports like any other consumer. Program A of that plan is the
extraction, done one session at a time on the worktree branch
`feature/polis-extract`, with the crates staged under `src-tauri/crates/polis/`
until Session A7 lifted them into their own repo
([`sersiousSenpai/polis-memory`](https://github.com/sersiousSenpai/polis-memory),
2026-09-07); Redline links them by git rev since.

This document is the running record of that carve: what moved where, what
stayed and why, the rules each session obeys, and the referees that prove the
move changed nothing. Update it in the session that moves the code.

## Rules (every session)

1. **Byte-for-byte.** Moved code is the code Redline ran. A session may change
   a `crate::` path, a visibility, or an import; it never changes a body. If a
   body has to change, that is a separate commit with its own reason.
2. **Shims stay behind.** The old module keeps a `pub use` of every moved item,
   so `crate::ledger::compute_entry_hash`, `crate::classmem::ClassNode`,
   `crate::context::AnswerPack`, `crate::db::BrowseHit`… all still resolve.
   Call sites are untouched; the diff is the move.
3. **Polis never depends on Redline.** Nothing under `crates/polis/` may name
   `redline_lib`. `polis-core` is I/O-free by test (no rusqlite / fs / net /
   process / tokio / reqwest in any module; the manifest names exactly
   `serde`, `serde_json`, `sha2`).
4. **Schema is the authority, never the integer.** `PRAGMA user_version` is
   shared with another lineage (the live DB is stamped 2); `polis-store` keeps
   its own `polis_meta` table and never touches `user_version`.
5. **Worktree, never `git stash`.** Concurrent sessions edit the main tree
   live; the running `tauri dev` restarts on any write under `src-tauri/`.

## Referees

| Referee | Where | What it pins |
|---|---|---|
| Memory schema golden | `tests/schema_golden.rs` → `tests/golden/memory_schema.sql` | Every `sqlite_master` row of the 14 memory tables + the 5 FTS tables (their indexes, triggers and shadow tables), from a fresh in-memory `Database`, in creation order. A2 moves the DDL into `polis-store`; this is what "byte-for-byte" means for SQL. Regenerate only for a real migration: `UPDATE_GOLDEN=1 cargo test --test schema_golden`. |
| Entry-hash vector | `polis-core/src/ledger.rs` `entry_hash_vector_is_pinned` | `compute_entry_hash(GENESIS_PREV, canonical event)` equals a digest computed outside Rust (python `sha256`). Field order, `null` spelling and the `prev ‖ json` concatenation cannot drift without every chain verifying red. |
| I/O-free core | `polis-core/src/lib.rs` `guards` | The manifest's dependency list and a source scrape of every module. |
| Guard arming | `src/ledger.rs` `every_constructed_agent_prompt_is_claimable` | ≥ 20 `register_agent_prompt(` sites across the surfaces still hand the guard a body, not a hash (31 after A1). |
| Retrieval never writes | `src/context.rs` `retrieval_modules_never_write_the_catalog` | Now reads the MOVED `query.rs` / `dedup.rs` sources, not the one-line shims. |
| Lean core | `tests/size_guard.rs` `core_has_no_native_deps_by_default` | polis-core's manifest = serde/serde_json/sha2 (no target / build tables) AND `cargo tree` one edge below it links exactly those three. |
| Lean deps | `tests/size_guard.rs` `polis_deps_stay_lean` | No polis manifest names Redline; one source for every polis crate; Redline asks for `apple` only; the RESOLVED features carry no `cli` / `standalone` / `anthropic` / `openai-compat`. |
| Sources through the dep | `tests/common/mod.rs` | Every source-scraping guard reads the polis crates wherever cargo put them (`cargo metadata` → `manifest_path`), so the git dependency is scraped exactly as the staged tree was. |

## Session A1 — `polis-core` (built 2026-09-06)

Everything pure. `crates/polis/polis-core` compiles with `serde + serde_json +
sha2`, 41 tests, no I/O.

| Core module | Lifted from | Items | Left behind (and why) |
|---|---|---|---|
| `query.rs` | `src/query.rs` (`git mv`) | whole file | one-line shim |
| `dedup.rs` | `src/dedup.rs` (`git mv`) | whole file | one-line shim |
| `ledger.rs` | `src/ledger.rs` | `GENESIS_PREV`, `PromptSource`, `CorpusRole`, `Origin`, `EventKind` (21 kinds), `now_millis`, `sha256_hex`, `body_hash`, `CanonicalEvent`, `compute_entry_hash`, `LedgerAppend`, `LedgerEventRow`, `PromptRow`, `BrowseEventRow`, `ChainVerdict`, `decision_payload_hash`, the agent-prompt guard (`register_agent_prompt` / `claim_agent_prompt`), `GUARD_TTL`; new generic `TtlGuard<V>` | `local_author` (reads `REDLINE_AUTHOR`; identity is E2's), `LaunchClaim` + the plan-launch and orchestration guards (Redline handoffs → `IngestObserver` in A6; now instances of `TtlGuard`), `ThreadRef`, `PromptInput`, `resolve_parent`, every `record_*` (need the store) |
| `types.rs` | `src/classmem.rs`, `src/context.rs`, `src/db.rs` | `ClassNode`, `ClassLink`, `ClassObservation`, `LakeItem`, `StageResult`, `UserNote`, `ContextStats`, `LedgerFilters`, `clamp_ledger_limit`, `LEDGER_PAGE_MAX`, `PREVIEW_CHARS`, `TimelineItem`, `MapNode`, `MapEdge`, `MemoryMapView`, `BrowseHit`, `GrepHit`, `GrepScope` | `ClassProposalRow`, `ClassRun`, `SupersessionOutcome` (store-side rows; move with A3) |
| `proposal.rs` | `src/classmem.rs` | `SplitPart`, `Proposal` (7 ops), `parse_proposals`, `SUPERSEDE_CONFIDENCE_MIN`, `SupersedeVerdict`, `parse_supersede_verdicts` | `new_node_id` (uuid — a store concern), `stage_proposals`, prompts, organize |
| `coldness.rs` | `src/classmem.rs` | `BranchStat`, `LakeEnvelope`, `COLLAPSE_FRESH_FRACTION`, `auto_collapse_safe`, `subtree_stats` | `days_between` (only the classifier prompt uses it) |
| `pack.rs` | `src/context.rs` | `MAX_CONTEXT_BYTES`, `budgeted_item_count`, `ANSWER_PACK_LIMIT(_MAX)`, `clamp_answer_pack_limit`, `PackLink`, `PackNode`, `PackPromptHit`, `AnswerPack`, `enforce_pack_budget` (now `pub`), `Arm`, `ArmHit`, `RRF_K`, `rrf_fuse`, `ArmCoverage`, `INLINE_*`, `render_answer_pack_block`, `clip_line` (now `pub`), `prefetch_status_label` | `build_answer_pack` and every other builder (`build_digest`, `build_session_history`, `build_stats`, `build_memory_map`, `query_ledger`) — they read the store; the two Redline-only ones (`build_session_history`, `build_digest`) stay for good |
| `bundle.rs` | `src/bundle.rs` | `BUNDLE_SCHEMA`, `BundleScope`, `BundlePrompt`, `BundleRevision`, `BundleTree`, `BundleNote`, `ContextBundle`, `BundleVerdict`, `canonical_of` (now `pub`), `verify_bundle` | `build_bundle`, `full_tree`, `class_scope`, `ClassKeep` (store reads) |
| `gist.rs` | `src/keeper.rs` | `GIST_HEAD_CHARS`, `GIST_TAIL_CHARS`, `deterministic_gist` | everything else in the keeper (the watch bus stays in Redline for good; the memory passes lift in A5) |
| `json.rs` | `src/keeper.rs` + `src/classmem.rs` | ONE `extract_object_with_key` + `matching_brace` (the two identical copies are gone; `classmem`'s `extract_json_object` is now `extract_object_with_key(text, "proposals")`) | — |
| `api.rs` | new | `MemoryApi` (sync, object-safe), `Scope`, `MemoryError`, `SearchRequest`, `GrepRequest`, `TreeRequest`, `TreeNodeView`, `LinkView`, `NodeView`, `PromptsRequest`, `RememberRequest`, `IngestItem/Request/Receipt`, `AnnotateRequest`, `ForgetRequest/Receipt`, `SupersedeRequest/Receipt`, `WriteReceipt` | bound by the `Polis` handle in A5, served in A6; `lib.rs`'s tree/node handlers already build `TreeNodeView` / `LinkView` from here |

Tests moved with their code (hash vectors, guard semantics, corpus-role
table, proposal parsing, verdict gating, subtree rollup, collapse interlock,
RRF, pack budget, prefetch ticker, gist head+tail). Tests that need a
`Database` stayed and call the moved functions through the shims.

Two visibilities changed and nothing else: `Database::open_in_memory` lost
its `#[cfg(test)]` (the schema golden is an integration test and links the
non-test lib), and `GrepScope::wants_prompts/wants_browse` became `pub`.

Also carried on this branch: `tests/golden/stream/*.jsonl` — HEAD's meter
tests already read them, but they were untracked on `main`.

## Session A2 — `polis-store` attach + schema (built 2026-09-06)

The memory DDL, the lexical layer and the chain append leave `db.rs`;
`Database` becomes a host that attaches the store to its own connection.

| Store module | Lifted from | What | Notes |
|---|---|---|---|
| `schema.rs` | `migrate_v1`'s batch (35 of its 98 statements) + the memory ALTER/index/archive/browse-column blocks + the corpus-role backfill + `embeddings` + the post-lexical provenance columns | `Migration::{tables, additive, embeddings, provenance, verify}`, `MEMORY_TABLES`, `LEXICAL_TABLES`, `schema_sql` (the golden's dump), `SYSTEM_INDEX_CHARS`, `CORPUS_ROLE_VERSION` | Every block keeps its original 8-space body indentation on purpose: multi-line SQL literals are stored by SQLite as written, and the golden proved the move byte-identical without regeneration |
| `lexical.rs` | the versioned lexical block | `Lexical::ensure`, `TOKENIZER`, `PREFIX_SIZES`, `LEXICAL_VERSION` | reads/writes `polis_meta.lexical_version` instead of `app_settings` |
| `meta.rs` | new | `polis_meta(key, value)`: `schema_version` / `lexical_version` / `corpus_role_version`; `adopt_legacy` copies the two `app_settings` keys ONCE (first attach, detected by a missing `schema_version`) | **never `PRAGMA user_version`** |
| `ledger.rs` | `Database::append_ledger_event_locked` (body verbatim as `append_in_txn`) | `append_event`: `BEGIN IMMEDIATE` + jittered retry on BUSY when the connection is in autocommit; joins the caller's transaction otherwise | R9: two processes on one file can no longer both read one head |
| `lib.rs` | new | `PolisStore::{attach, open, open_in_memory, require_capabilities, run_migrations, conn, shared_connection, last_attach, meta, set_meta, schema_sql, append_event}`, `AttachOptions::{redline, standalone}`, `AttachReport`, `StoreError` | `open` = WAL + `synchronous=NORMAL` + `busy_timeout=5000`; `require_capabilities` = sqlite ≥ 3.34 and `ENABLE_FTS5` in `compile_options` |

Host side (`db.rs`): `Database { conn: Arc<Mutex<Connection>>, polis: PolisStore }`
with `Deref<Target = PolisStore>`; `open`/`open_in_memory` run the host's own
`migrate` (now `fn migrate(conn)`) and then `PolisStore::attach(…, AttachOptions::redline())`;
`verify_schema`'s core-table list drops `prompts`/`ledger_events` (the store
verifies its own); `append_ledger_event_locked` delegates to the store; the
lexical constants are re-exported from `polis_store`. Test adapted:
`corpus_role_backfill_reclassifies_without_touching_the_chain` deletes the
`polis_meta` key and calls `run_migrations()`.

Attach semantics: `polis_meta` is created → if `schema_version` is absent, the
two legacy keys are adopted → if any of the three versions is behind, the
idempotent migration runs once and stamps → `Migration::verify`. An
already-current store runs no schema SQL (`AttachReport::migrated == false`).

Referees added: `tests/polis_store_guard.rs` (`Database` and `PolisStore`
share no `self` method — Deref precedence would hide the store's) and
`real_db_attach_is_a_noop` (`REDLINE_REAL_DB` on a COPY of the live DB: 2 keys
adopted, zero events, bodies/gists byte-unchanged, chain head unchanged, no
schema object dropped/rebuilt/added besides `polis_meta`, chain green, reopen
on the fast path). The A1 schema golden passed UNCHANGED after the move.

## Session A3 — the store's methods + `polis-embed` (built 2026-09-06, three commits)

~120 `Database` methods become `PolisStore` methods, verbatim except for
`crate::` paths, in three commits by table group. Redline reaches every one
through `Deref` and no call site changed. The pattern-slicing script that did
it classified each `impl Database` method by the tables its SQL literals name;
memory-only methods moved, host-only stayed, and the six mixed ones were
decided by hand (below).

| Commit | Store modules | Methods | Also |
|---|---|---|---|
| 1/3 | `prompts`, `compaction`, `chain`, `search` | 48 (+ `row_to_user_note`, `row_to_class_node` early, because search needs them) | polis-core gains the store-side row/outcome types (`ClassProposalRow`, `ClassRun`, `SupersessionOutcome`, `StagedOutcome`, `AppliedReorg`, `DECISION_KINDS`, `PromptFilters`, `NoteWrite`, `NoteOutcome`, `MirrorRow`) and `polis_core::vec` (chunking, int8 quantize/cosine/pack/unpack, with their six tests) |
| 2/3 | `catalog`, `supersessions`, `notes`, `observations` | 52 (+ `new_node_id`, uuid is the store's) | the host's `append_ledger_event_locked` deleted with its last caller |
| 3/3 | `browse`, `embeddings`, `session_tree`, `exports` | 20 | **`polis-embed`**: `Embedder`, `ProviderKind`, the Apple backends behind feature `apple`, `VectorCache`, `semantic_search(store, embedder, …)`, `index_tick(store, embedder, …)`; Redline's `embed.rs` keeps provider SELECTION (the `app_settings` cloud opt-in, `CloudEmbedder` on Redline's reqwest/tokio, `provider_for`) and two signature-preserving wrappers |

Free items that moved with their methods: `GrepError`, `GREP_MIN_LITERAL`,
`GREP_EXCERPT_CHARS`, `PROMPT_TEXT`, `ARCHIVE_ALGO`, `deflate_body`,
`inflate_body`, the `VERIFY_*` anchor keys, `USER_NOTE_COLS` (all re-exported
from `db.rs` where anything still names them).

**Stayed on `Database`, and why** — the seams `HostResolver` (A4/A5) will
formalize:

| Method | Reason |
|---|---|
| `query_ledger_events` (the Timeline) | joins `surface_shots` (host) for a picture on non-browse events; calls the store's `filings_for_targets` / `row_to_ledger_event` through Deref |
| `decision_event_context` | joins `comments`, `review_annotations`, `revisions` — the plan's `HostResolver::decision_evidence` |
| `referenced_shot_keys` | `browse_events` × `surface_shots`; `shots.rs` stays in Redline |
| `un_exported_approved_sessions` | `plan_exports` × `sessions` |
| `seat_activity` | a host report that happens to count `class_runs` |
| `reject_class_proposal` | records a friction row (host); the row delete is now the store's `delete_class_proposal` |
| `clear_embeddings` | drops the in-memory vector cache (an embed-layer concern) around the store's `delete_all_embeddings` |
| `snapshot_to` | `VACUUM INTO` of the WHOLE file — the host's backup; Polis gets its own in E1 |

Semantic changes, each named: the incremental verify's `(lastSeq, headHash)`
anchor lives in `polis_meta` (one full re-walk on first attach, then
incremental); `accept_node_chain` takes the author it stamps instead of
reading the host's `local_author()` (the store carries `author`, Redline
passes `local_author()` at attach); the two `#[cfg(test)]` wrappers
(`apply_supersession`, `subtree_has_pin`) are plain methods in the store
because a crate's cfg(test) does not reach a host's tests.

Guards followed the code: `classifier_delta_takes_no_query` reads the store's
catalog source; the poison guard's `lock_conn()` floor is 200 (289 sites
remain) and the same invariant — no bare unwrap on the shared lock, a
poison-recovering accessor, a use floor — covers every polis-store module
(`store_conn_is_never_locked_with_unwrap`).

## Session A4 — `polis-llm` + Redline's host adapters (built 2026-09-06)

The model behind the gardener becomes a trait, and Redline answers the host
traits.

**`polis-core::host`** (new, pure): `HostResolver` (label, thread stats,
project roots, revision markdown/title, session status, decision evidence —
`decision_evidence(seq)`, the real signature, not the plan's `(ref_kind,
ref_id)` sketch), `IdleSignal`, `Clock`, `GardenerEvents` + `Change`
(Memory / Catalog / Ledger / Embeddings), and `NoHost` / `SystemClock` for the
standalone binary and tests. `IngestObserver` is deferred to A6 with the
ingest route it observes (the handler is its only consumer).

**`polis-llm`** (new): `Agent` (async, object-safe: `AgentRequest { seat,
prompt, cwd, resume, response_key, max_output_bytes }` → `AgentReply { text,
json, session_id, usage, clipped }` / `AgentError { kind, message, usage,
session_id }` — usage rides the error too, so every exit can book),
`Usage`, `UsageSink` / `NoopSink`, `finish` (the one clip + JSON-extract).
Backends: `claude_cli::ClaudeCli` (`claude -p … stream-json`, adopts the
terminal `result.usage`), `codex_cli::CodexCli` (`codex -s read-only -a
never exec --json …`, resume by thread id, usage off `turn.completed`),
and behind features `anthropic::AnthropicApi` (`POST /v1/messages`,
`claude-opus-5`, thinking left at its default, server-side refusal
fallbacks on, `refusal` → turn error) and `openai_compat::OpenAiCompat`
(`/chat/completions`). `StreamLine` / `classify_line` moved here verbatim
from `claude_proc.rs` with seven of their tests (`claude_proc` re-exports;
the eighth test stays because it pins Redline's `is_transient`).

**`src/polis_host.rs`** (new): `RedlineAgent` — the memory seats' spawn
UNCHANGED (`resolve_claude_bin`, `register_agent_prompt`, `bridge_args`,
`claude_command_for_seat`, `collect_turn`'s `TurnMeter` fold); `RedlineUsage`
— books through `meter::book` via the new `TurnMeter::from_totals`, so the
seat-burn row is the same four counters and `spawns = 1` (pinned by a
round-trip test); `RedlineHost` over `Database`; `PtyIdle`; `WallClock`;
`TauriEvents` (the three window events + the extension host's
`ledger.changed`). `install_agent` at setup; `agent()` falls back to
`RedlineAgent` so tests need no setup.

**Rewired:** `classmem::run_classifier` and `keeper::run_keeper_summarizer`
keep their signatures and go through one `classmem::run_memory_agent(db,
seat, cwd, prompt, response_key)` — the classifier, the supersede verifier,
compaction, observations and the shots caption (all five spawn sites) now
pass through `Agent`, and every exit books through the sink. Error strings
are seat-named (`keeper produced no output`, was `summarizer …`; nothing
asserted on it). `ledger.rs`'s guard-arming scrape includes `polis_host.rs`.

## Session A5 — `polis-memory`, the facade (built 2026-09-07)

The memory logic leaves the host. What moved, by module, verbatim except for
the receiver and `crate::` paths:

| Facade module | Lifted from | Items |
|---|---|---|
| `organize` | `classmem.rs` | seeding (`GENERAL_ROOT_ID`, `root_id_for_path`, `seed_root_rows`), `stage_proposals`, the classifier prompt (`build_classifier_prompt`, `render_catalog_snapshot`, the head/tail clippers), `OrganizeOutcome`, `organize_once`, the supersede verifier (`build_supersede_verifier_prompt`, `verify_supersede_proposals`) + 5 tests |
| `gardener` | `keeper.rs` | the memory constants, `is_idle`, compaction (`PromptCand`, `group_candidates`, `pin_protected_nodes`, `select_compaction_candidates`, `build_keeper_prompt`, `parse_compaction_actions`, `compaction_pass`), observations (`select_observation_nodes`, `build_observations_prompt`, `parse_observations`, `observations_pass`) + 9 tests; NEW `GardenerConfig` / `GardenerState` / `Gate` / `StepOutcome` / `step` — the tick that lived in `keeper::spawn` (idle → debounce → growth → organize → compact → every-Nth observe → events), plus the semantic index on its own cadence (the retired `embedding-index` watch) |
| `retrieval` | `context.rs` + `lib.rs` | `clamp_prompt_limit`, `list_prompts`, `build_stats(_cached)`, `build_memory_map`, `build_answer_pack`, `build_thread_tree`; NEW `query_ledger` (store rows + the host's `surface_shot_keys`), `tree_view` / `subtree_ids` / `node_view` (the tree and node routes' assembly, once, for the router, the MCP tools and the commands) |
| `bundle` | `bundle.rs` | `build_bundle`, `full_tree`, `ClassKeep`, `class_scope` |
| `mirror` | `mirror.rs` | everything: `note_for`, `collect_notes`, `sync`, `rebuild`, `status`, the settings (now `polis.mirror.dir` / `polis.mirror.lastSeq` in `polis_meta`) |
| `agent` | new | `run_memory_agent` (one seam: agent → sink on both exits), `run_classifier`, `run_keeper_summarizer`, `NO_MODEL` |
| `skill` | `skills/classmemory/SKILL.md` (`git mv` to the staging tree) | `CLASSMEMORY_SKILL` — one file, included by both crates; the text still names the host's bridge (E1 templates it) |
| `lib` | new | `Polis<'a>` (store + `Option<Agent>` + `HostResolver` + `UsageSink` + `Option<Embedder>`) with the host seams spelled as the moved bodies call them (`get_setting` → `polis_meta`, `list_project_paths` → `project_roots`, `thread_stats`/`thread_label`, `revision_markdown`, `decision_event_context` → `decision_evidence`, `reject_class_proposal` → store delete + log, `query_ledger_events` → store + shot join); `PolisHandle` (owned) implementing **`MemoryApi`** end to end: search, grep, tree, node, prompts, timeline, stats, map, verify, remember (prompt row or standalone note), ingest (`record_prompt_at` with the item's clock, dedup on `(body_hash, run)`), annotate, forget (`confirm: "forget"`, prompts only until E2), supersede, stage_proposals |

`polis-store` gained `record.rs` (the A3 item deferred): `ThreadRef`, `PromptInput`,
`record_prompt` / `record_prompt_at`, `BrowseAction`, `BrowseEventInput`,
`record_browse_event`, `record_revision_event`, `DecisionInput`,
`record_decision`, `record_session_link`, `record_work_event`,
`record_moot_turn`, `resolve_parent`, and the catalog writers
`record_curate` / `revert_link` / `record_reorg` — the default author is the
store's. `query_ledger_events` moved to the store minus its `surface_shots`
join; `HostResolver::surface_shot_keys` (default: none) is the host half.
`polis_core::ledger::PromptSource::Api` names what `remember`/`ingest` write.

**Host side.** `Database` implements `HostResolver` and `UsageSink` itself
(`polis_host.rs`); `polis_for(&db)` builds the borrowed view every shim uses,
and `install_polis` stores the owned handle for A6. `Database.polis` is an
`Arc<PolisStore>` so the handle can share it. `keeper::spawn` keeps the watch
bus and calls `gardener::step` for the memory passes; the `embedding-index`
watch is gone (the step owns the cadence). Every Redline module keeps
signature-preserving shims over `polis_for` (20 of them) so no command,
route or test changed; the shims nothing calls any more were deleted, and the
ones only tests call are `#[cfg(test)]`. `meta::adopt_legacy` copies six keys
on first attach (the two versions + the four settings above).

**Stayed on the host, on purpose:** `build_digest` / `render_digest_prompt_block`
and `build_session_history` (friction and plan history are Redline's),
`record_agent_prompt` (arms the hook guard) and `record_review_verdict`
(writes a host setting), `provider_for` (setting-driven provider selection),
the watch bus, the friction row on a refuted proposal (the B2 journal is its
successor — the facade logs the refusal).

**Gates.** `real_db_gardener_ticks_behave` (`REDLINE_REAL_DB`): twenty
`gardener::step` ticks over a copy of the live database with no model — the
gates evaluate, nothing errors, nothing lands on the chain, the chain stays
green. `real_db_attach_is_a_noop` still passes (now `>= 2` keys adopted).
`the_gates_hold_and_a_run_without_a_model_reports_no_model` pins the gate order
and the R12 state on a fresh store.

## Session A6 — `polis-server`, the HTTP surface (built 2026-09-07, two commits)

The memory routes leave `lib.rs`; Redline merges the router it used to be.

**`polis-server`** (new; `polis-core` + axum 0.7 + serde + tokio `rt`):

| Item | What | Notes |
|---|---|---|
| `router<S>()` | `Router<S>` over `Arc<dyn MemoryApi>` for any host state with `PolisState: FromRef<S>`; handlers take `State<PolisState>` (`api`, `ingest: Arc<dyn IngestObserver>`, `events: Arc<dyn GardenerEvents>`) | Redline: `.merge(polis_server::router())` + `FromRef<AppState>`; standalone: `S = PolisState` |
| `ROUTES: &[RouteSpec]` | 24 rows, classes `Open \| HookContract \| Write(scope)`, registration order = table order (pinned by `routes_match_router_registrations`; `every_route_in_the_table_is_served` drives each row through the real router) | the source of `docs/api-v1.md`'s polis rows and the G2 clients |
| `routes.rs` | Redline's 11 handlers moved verbatim onto `MemoryApi` calls — `/v1/memory/{tree,node/:id,prompts,answer-pack,grep,proposals}`, `/v1/context/{prompts,stats,browse/search,threads/:kind/:id,tree/:kind/:id}` — same query shapes, same bodies, same codes (the 502 `{error}` failure shape kept; `MemoryError` maps Rejected→400 with the reason, NotFound→404, Unavailable→503, Store→502) | `/v1/context/sessions/:id/history` STAYS in Redline: `build_session_history` reads plan revisions + comments (host tables); `/v1/context/{overview,codehealth}` stay as planned |
| §4.4 routes | reads `GET /v1/memory/{context,ledger,verify,health,map}`; writes `POST /v1/memory/{remember,annotate,forget,events,browse,organize,reindex}` | scopes: `memory.write` (remember/annotate/events/browse), `memory.forget` (its own grant — destructive), `memory.organize` (organize/reindex), `memory.propose` (proposals, unchanged). `runs/:id/revert` is B2, `/v1/sync/*` is C, `/mcp` is E1 |
| `ingest.rs` | `POST /v1/prompts/ingest` moved as a route: the handler body is Redline's, every host-shaped fork asked of the `IngestObserver` in a fixed order — `intercept` → `agent_seat` → the consume-once guard + `seat_suppresses` → (`on_agent_prompt_skipped`, return) → `classify_origin` → `capture_external` → `MemoryApi::capture` → `on_recorded` | the six response bodies (`too_large`, `unparseable`, `empty`, `agent_dup{by,seat}`, `external_off`, `dup`/`error`, 201 `{seq}`) pinned by `the_hook_json_shapes_are_unchanged`; `ingest_prompt_text` moved (Redline re-imports it for its golden payload test) |
| `hook.rs` | `CaptureHookSpec { ingest_url, headers: [(name, env)], timeout_secs }` → `command()`, `installed_at`, `current_at`, `install_at`, `uninstall_at` — Redline's capture half, generalized | Redline's spec = the daemon URL + 4 shell-expanded headers (`X-Redline-Agent`, the 3 restore headers); its command is **byte-identical**, pinned by `capture_command_is_pinned` (written against the old code first) |
| `standalone.rs` (feature) | `serve(addr, state, StandaloneAuth{token})`: the three-class token guard over `ROUTES`, fail-closed on unlisted routes, non-loopback bind refused without a token | `cargo test -p polis-server --features standalone` |

**`polis-core`**: `MemoryApi` gained `list_prompts`, `browse_search`,
`thread_tree`, `thread`, `context`, `health`, `capture`, `browse`,
`organize` (the ONE async method — a boxed `Send` future, no `async_trait`
in core) and `reindex`, with `CaptureRequest`, `BrowseRequest`,
`ContextRequest`/`ContextBlock`, `OrganizeReceipt`, `ReindexReceipt`,
`HealthReport`, `ThreadMessage`. `host.rs` gained `IngestHeaders`,
`IngestContext`, `IngestObserver` (every method defaulted; `NoIngestObserver`)
and `HostResolver::thread_messages` (default `None` — the per-surface
message tables are the host's). `Origin`, `ChainVerdict`, `StageResult`
gained serde derives; `PROMPT_LIMIT_MAX` / `clamp_prompt_limit` /
`MAX_DELTA_ITEMS` moved to `types` (shims in `polis-memory`).

**`polis-memory`**: `PolisHandle` implements the new methods (`capture`
builds the hook's exact `PromptInput` — `source: Hook`, the captured-text
role classifier, no seat, no model); `retrieval::thread_view` (the threads
route's clip + tail-budget assembly, verbatim, over `thread_messages`) and
`retrieval::context_block` (plan → pack → `render_answer_pack_block`).

**Host side.** `lib.rs`: the 12 `.route(...)` lines are one
`.merge(polis_server::router())`; `AppState.polis: PolisState` built at setup
from `polis_handle()` + `RedlineIngest` + `TauriEvents`; the 11 handlers,
`handle_prompts_ingest` and their query structs deleted (`build_node_view`
stays for the Tauri command). `polis_host.rs`: `RedlineIngest` (the old
handler's restore answer, seat header, `RESTORE_SEAT` exemption, the
launch/orchestration handoff blocks verbatim, `classify_prompt_origin`, the
`redline.capture.externalSessions` setting, `backfill_from_transcript`) and
`HostResolver::thread_messages` over `load_thread_generic`.
`restore_context`: `from_lookup` / `answer_with` over `IngestHeaders` (the
`HeaderMap` forms are `#[cfg(test)]`). `hook.rs`: the capture half is thin
wrappers over Redline's `CaptureHookSpec`. `auth.rs`: `ROUTE_TABLE` shrank by
the 12 rows and **`all_routes()`** = own rows + mapped polis rows
(`Write(scope)` → `Protected(scope)`); the middleware, `route_spec` and the
doc render read `all_routes()` — the fail-closed rule made the mapping
mandatory. `redline-extension-abi` gained the three memory scopes (pinned
equal to `polis_server::scopes` by `polis_scopes_match_the_extension_abi`).
`docs/api-v1.md` and `docs/extensions-api.md` regenerated.

**Referees added:** `merged_router_covers_every_polis_route` (the polis
router under `require_daemon_auth`, over an in-memory `Database`, every row
with the master token — none 401s, none is an empty 404; without the token
the reads pass and a write bounces), `polis_rows_join_the_contract_with_their_classes`,
`routes_match_router_registrations`, `every_route_in_the_table_is_served`,
`the_hook_json_shapes_are_unchanged`, `the_observer_is_asked_at_every_fork`,
`capture_command_is_pinned`. The existing drift test
(`route_table_matches_router_registrations`) still scrapes `lib.rs` against
Redline's own rows.

**Semantic changes, each named:** a store error under the threads route now
reads as "unknown thread kind" (404) rather than 502 (`thread_messages` is an
`Option`); a grep whose store call fails is 502 rather than 400 (the refusal
path — the only one clients ever saw — is unchanged: 400 with the reason).

## Session A7 — guards, the extraction, Redline on the git dependency (built 2026-09-07, three commits)

**The repo.** [`sersiousSenpai/polis-memory`](https://github.com/sersiousSenpai/polis-memory)
(public), cut with `git filter-repo` from a fresh `git clone --no-local` of
this branch — never from the worktree or the main repo. The filter kept
`src-tauri/crates/polis/` plus the pre-move paths of the three `git mv`'d
files (`src-tauri/src/query.rs`, `src-tauri/src/dedup.rs`,
`skills/classmemory/SKILL.md`), and `--path-rename`d the six crates into
`crates/` (the plan's §4.1 layout). Result: 13 commits — A1–A6's nine plus the
four Redline commits that first wrote those files — and `git log --follow`
crosses A1 / A5 into them. The one-line query/dedup shims that rode along were
dropped from the tree in the root commit. **What cannot be split:** the history
of every carved body — the store out of `db.rs`, the vocabulary out of
`ledger.rs`, the organizer and gardener out of `classmem.rs` / `keeper.rs`,
retrieval out of `context.rs`, `bundle.rs`, `embed.rs`, `claude_proc.rs`,
`hook.rs`, the routes out of `lib.rs` — stays in this repo; the new README's
"Where the history is" says so and points back here.

**The root the staging tree never had.** Workspace `Cargo.toml` (six members;
`[workspace.package]` inherited by every crate: 0.1.0, edition 2021,
Apache-2.0, repository; **`rust-version = "1.85"`** — the floor the graph set,
`reqwest` 0.13 and `uuid` 1.23, verified with `cargo +1.85.0 check
--all-features --locked`; **resolver 3** so the lockfile prefers MSRV-fitting
versions — the first fresh lockfile had pulled `icu_*` 2.3 / `idna_adapter`
1.2.2, which want 1.86–1.88; `[workspace.dependencies]` carrying `version`
beside `path` so `cargo publish` can strip the path), `Cargo.lock`,
`.gitignore`, `.gitattributes` (`* text=auto eol=lf`), `LICENSE`, `NOTICE`,
`deny.toml` (header rewritten, allowlist identical to `src-tauri/deny.toml`),
`README.md` rewritten, and `.github/workflows/ci.yml` now live: test + clippy
`-D warnings` on macos-14 / ubuntu / windows with default AND all features,
keyless (no key, no `claude`/`codex`/`ollama`), cargo-deny, an msrv job on the
pinned `rust-version`, and lean-core (`cargo tree -p polis-core --edges normal
--depth 1` = serde, serde_json, sha2). The `classmemory` skill moved INSIDE
`crates/polis-memory/skills/` — a file outside the package root does not ship
in the `.crate`, and `cargo publish --dry-run --workspace` verifies all six.

**Body changes, each named (rule 1: their own commit, their reason).** Clippy
at `-D warnings` was never run on these bodies in Redline; the new CI runs
it. Five mechanical, semantically identical edits: `search.rs`
`sort_by(|a, b| b.ts.cmp(&a.ts))` → `sort_by_key(|b| Reverse(b.ts))`;
`record.rs` a doc-comment precedence list rendered as a markdown list;
`dedup.rs` (test) `&vec![…]` → `&[…]`; `process.rs` (test) `.err().expect()`
→ `.expect_err()`; `polis-embed` (test) the margin check as a `const {
assert!(…) }` block. `type_complexity` is allowed workspace-wide (the store's
documented row tuples). Then CI's first run went red on windows-latest only:
`routes_match_router_registrations` scrapes `lib.rs` for `"\n}\n"` and the
runner checks out CRLF — fixed by the `.gitattributes` and by normalizing
CRLF in the scrape (fe2bafd, the rev Redline pins).

**Redline on the git dependency.** `git rm -r src-tauri/crates/polis`; the six
members out of both workspace lists; the six deps →
`{ git = "https://github.com/sersiousSenpai/polis-memory", rev = "fe2bafd…" }`
with the same features (`apple` on polis-embed and polis-memory, nothing
else); `Cargo.lock` regenerated. `skill.rs` embeds
`polis_memory::skill::CLASSMEMORY_SKILL` (the crate's bytes, not a copy).
Every guard that scraped a staged source now resolves the crate through
**`tests/common/mod.rs`** — `cargo metadata --locked --offline` → the
package's `manifest_path` → `polis_source(crate, rel)` — shared by the
integration tests (`mod common;`) and the lib's unit tests (`lib.rs` mounts
the same file as `crate::polis_src` under `cfg(test)`): `poison_guard`'s
store sweep, `polis_store_guard`, `context::retrieval_modules_never_write_the_catalog`
+ `classifier_delta_takes_no_query`, `meter::memory_seats_fold_in_the_agent_and_book_in_the_runner`.
`launchInvariants.test.ts` (the FE job has no cargo) now reads the
`${VAR:-}` rendering from Redline's own pinned bytes
(`capture_command_is_pinned`) instead of the spec's source. `auth.rs`'s doc
render names the new repo; `docs/api-v1.md` regenerated (one line).

**Guards added (the two the plan named), in `tests/size_guard.rs`:**
`core_has_no_native_deps_by_default` — polis-core's manifest names exactly
serde/serde_json/sha2 with no target or build-dependency table AND `cargo
tree -p polis-core --edges normal --depth 1` links exactly those three (a
manifest cannot see a dependency that arrived through a feature);
`polis_deps_stay_lean` — no polis manifest names Redline, every polis crate
resolves from ONE source, `src-tauri/Cargo.toml` asks for `apple` and nothing
else, and the RESOLVED feature set of every polis package carries none of
`cli` / `standalone` / `anthropic` / `openai-compat`. Both were green while
the crates were still staged (commit 1/3) and again on the git dep.

**Size (release, this machine, `npx tauri build --bundles app`):** main @
ba3b8cf 30,540,160 B (CI's `size.yml` measured 30.39 MB on the same commit);
this branch on the staged path deps 31,080,064 B; on the git dep **31,096,528 B**.
So the budget (28.0 MB in `scripts/size-budget.json`; the plan's gate 27.4 MB)
was already breached on main by ~2.5 MB before Program A, A1–A6 added
~0.54 MB (the new §4.4 routes and their serde types, the second `MemoryApi`
surface, the Codex backend), and the git dependency itself adds +16,464 B (0.05%): not a dependency or a feature (the resolved features are `apple` only; the guards say so) — ~2 KB of it is the longer `~/.cargo/git/checkouts/…` source paths in the 30 panic-location strings, the rest ordinary codegen variance across the re-resolved graph.
Nothing here loosens the budget; the overage is main's and predates the
extraction — a lever list for it belongs to its own session.

**Verified on the git dep:** `cargo test --workspace -- --test-threads=1`
(lib 1121 + every integration target), `cargo deny check licenses`, `real_db_attach_is_a_noop` +
`real_db_gardener_ticks_behave` on a copy of the newest backup
(5735 events / 2164 prompts / 8,671,323 B / 244 objects unchanged; 20× `Ran`, 0 appended), `npx tsc` + vitest (1893 green). New repo CI: green on all seven jobs — <https://github.com/sersiousSenpai/polis-memory/actions/runs/34105353695>.

## Sessions B1 ∥ E1 — instruments + baseline, the `polis` binary + MCP read + restore (built 2026-09-07, parallel sessions in the new repo)

The first two sessions after Program A ran side by side as two agents on two
worktrees of `polis-memory` (branches `b1-instrument`, `e1-mcp`, both from
fe2bafd), merged onto main as af5fa59, and land in Redline as a rev bump plus
E1's Redline half. Redline pins that rev (`src-tauri/Cargo.toml`, seven
lines now — `polis-mcp` joined).

### B1 — instrument + baseline (`docs/bench.md`, `bench/results/`)

**Instruments.** `polis_core::latency` (pure: a 256-sample ring per op,
process-global, a `Timer` guard, nearest-rank percentiles; core's deps still
exactly serde/serde_json/sha2); `ContextStats.latency` on
`GET /v1/context/stats` and `MemoryApi::stats`; `polis_memory::latency`
spans (`ms`) + ring on every pack arm, `context`, `grep`, the write paths
and the gardener passes; polis-server's route layer records
`route:<pattern>`. `corpus.rs` (seeded SplitMix64 generator fitted to the
real lake, writing through the store's own paths) at 1k / 10k / 100k;
`canary.rs` (the §5.3 set + the regression rule); `eval.rs` (Recall@k, MRR,
pack-contains-gold, bytes/arms, results writer, the CI gate, the real-DB
instrument `POLIS_REAL_DB=<copy>`, the calibration; `--features eval`);
`benches/memory.rs` (criterion 0.7). CI gained an `eval` job (gate + `bench
--no-run`).

**Schema (a real migration — the reason for the golden regeneration below).**
`class_runs` + `duration_ms INTEGER, items INTEGER, ops INTEGER, model TEXT,
outcome TEXT, canary_before REAL, canary_after REAL, error TEXT` (additive
ALTERs in `Migration::additive`); `STORE_SCHEMA_VERSION` 1 → 2, so an
existing store re-runs the block once (`last_attach().migrated = true`, then
a no-op). `organize_once` fills the first six; the canary pair is B3's.

**Baseline (this machine, 2026-09-07; §6.1 rows in `docs/perf-budget.md`).**
Synthetic 1k / 10k / 100k, criterion means: pack warm 4.7 / 24.9 / 101 ms,
cold 4.9 / 24.8 / 101, grep 1.6 / 7.5 / 31, context 4.7 / 25.3 / 100,
semantic 0.21 / 2.2 / 18.2, fused pack 5.5 / 30.3 / 138, ingest 0.33 / 0.39
/ 0.53 — every 10k row holds. Real DB copy (2,164 prompts): pack p50/p95
14/27 ms, cold 19, context 19/32, grep 8/8; canary set (201 packs) p50
3.36 s against the 3 s row (12% over — the browse arm's FTS5 MATCH is 9 of
the pack's 14 ms), p95 3.47 s within 8 s. Accuracy (reachability, not
relevance): synthetic Recall@5/10/20 0.97, MRR 0.95; real copy 0.66/0.70/0.70,
MRR 0.59, canary 0.751 over 201 (Decision 55/100, Supersession 1/1,
PromptSpan 45/50, ClassReach 50/50, BrowseTitle 25/50; no notes exist). All
45 Decision misses sit past the pack's 40-link per-node cap of their class
(34 in one 317-link class) — the fan-out gap §6.3 names, not the canary.

**Calibration.** Ten reseeded freezes: aggregate σ 0.006 on both lakes (3σ
0.017), PromptSpan σ 0.018–0.023, the zero-tolerance subjects σ 0. The
plan's rule stands — `recall_after < recall_before − max(0.05, 3/N)`, zero
tolerance on Supersession/Note — the floor is 3× the observed noise and only
binds below N = 60. For B3: a run that files a previously unfiled decision
changes the probe set, so each run compares against its own frozen set.
Deferred: leave-one-out filing consistency (needs centroids, Program C);
semantic indexing at 100k is throughput-bound (C2).

### E1 — the `polis` binary, MCP read, restore (`docs/mcp.md`)

**`crates/polis-mcp`** (rmcp 3.2 — which raised the workspace MSRV 1.85 →
1.88, its own commit): the read surface over `Arc<dyn MemoryApi>` — 15 tools,
all `readOnlyHint` + `idempotentHint`, every result `structuredContent` + a
text summary citing `#seq`: `memory_search` (START HERE), `memory_context`,
`memory_grep`, `memory_tree`, `memory_node`, `memory_timeline`,
`memory_stats`, `memory_verify` (each with an optional `scope`), plus seven
aliases for the old proxy's names (`answer_pack`, `search_memory`,
`grep_memory`, `query_prompts`, `session_history`, `stats`,
`search_browsing`; `memory_tree` kept its name); resources `polis://tree`,
`polis://node/{id}`, `polis://event/{seq}`; prompt `memory-grounding`; the
`instructions` string names shared hits as third-party content. Backends:
Local (any `MemoryApi`) and `RemoteApi` (an HTTP client over polis-server's
routes; `ureq`, not reqwest — the trait is synchronous and a blocking reqwest
cannot run inside the MCP server's runtime). **rmcp's streamable HTTP service
mounts into axum 0.7** (http 1 / tower-service 0.3 line up), so Redline
serves `/mcp` itself; no bundled binary.

**Restore plumbing.** `PolisStore::snapshot_to` (`VACUUM INTO`),
`quick_check`, `open_read_only`; `polis_memory::backup` (`BackupPolicy` 6 h /
keep 7, `backup_now`, `prune`, `verify_snapshot` = schema check + chain walk
— FTS5's integrity pass refuses a read-only connection, so `quick_check`
runs on the live file, `newest_verifying`, `restore` keeping the live file as
`polis.db.bad`); gardener `backup_dir` / `backup_every_ms` / `backup_keep` +
`last_backup_ms` and one delimited block at the top of `step`.

**The `polis` binary** (`polis-memory` feature `cli`; never enabled by a host
— `polis_deps_stay_lean` pins it off): `init` (home, `polis.db`, 0600 `token`,
`config.toml`; identity keys are E2), `serve` (127.0.0.1:7677, `/mcp` nested,
`serve.json`, the gardener loop under `gardener.lock`, backup on start / 6 h
/ shutdown with verify + keep 7; non-loopback refuses without `--token-file`),
`mcp` (Remote when `serve.json` is alive, else Local; `--remote`), `hook
install|uninstall|status` (the command is `<abs polis> capture`, no shell
quoting), `capture` (daemon if alive, else local; exit 0, 1 s), `search`,
`context`, `grep`, `tree`, `stats`, `verify`, `doctor` (offers restore on a
red chain or a failed `quick_check`), `restore [--from]`, `backup`, `mcp
install --client claude|codex|project`. Release binary 8,760,320 B (thin
LTO, 1 CGU, stripped) against the plan's 12–16 MB. Smoke, end to end with
no daemon and then with one: init → capture → search returns the seq →
stdio MCP `memory_search` → serve → `curl /mcp` initialize → capture via the
daemon → shutdown snapshot verified → corrupt the file → doctor red + offers
restore → restore → verify green.

**Redline half (a5da4f2).** The daemon serves `/mcp` as a ROUTE
(`any_service`), not a nest: axum 0.7's `nest_service` gives a nested tail no
`MatchedPath`, which the fail-closed `require_daemon_auth` needs — three
`Open` rows (`POST/GET/DELETE /mcp`) in `ROUTE_TABLE`, `docs/api-v1.md`
regenerated, and `merged_router_serves_mcp_initialize_and_tools_list` drives
a real `initialize` + `tools/list` through the merged router under the auth
layer. `crates/redline-mcp` deleted; `mcp.rs` is the HTTP snippet
(`claude mcp add --transport http redline http://127.0.0.1:7676/mcp`);
`mcpBinBytes` retired from the size budget, the size/release/ci workflows,
`redline.sh` and the docs; `size_guard::mcp_proxy_stays_split_and_lean`
rewritten (no proxy crate, the app's reqwest never regains `blocking`,
`/mcp` served by `polis_mcp`); skills `context-analysis` v3 / `sensei` v2
teach the new tools and the transport. **`session_history` is not what the
old tool served:** Redline's `HostResolver::thread_messages("session", id)`
is the discussion thread, not the plan-session history
(`/v1/context/sessions/:id/history`, which stays a plain localhost GET); both
skills say so. `Database::snapshot_to` went (the store's, through `Deref`,
is the same `VACUUM INTO`; the Deref method-name guard caught the collision).

## Sessions ahead

Programs B and E continue in the new repo, landing here as rev bumps:

| Program | Session | Work |
|---|---|---|
| B (autonomy) | B2 | retire-marks, `class_run_ops`, pre-images, `revert_run`, `GardenerRevert`; the Redline run timeline + Undo |
| E (MCP, identity, sharing) | E2 | keys + device sub-principals, `PrincipalBind`, scope columns, the write tools and routes, signed export/import; `session_history` needs a host hook if it is to answer the plan-session history |

## How to run

```sh
# The crates — in the polis-memory repo (git clone https://github.com/sersiousSenpai/polis-memory)
cargo test --workspace                           # every crate, default features
cargo test --workspace --all-features            # + the HTTP backends, the standalone daemon, the Apple embedder (macOS)
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo deny check licenses
cargo +1.85.0 check --workspace --all-features --locked   # the MSRV
cargo publish --dry-run --workspace              # packages + verifies all six in dependency order

# Redline on the git dependency — in src-tauri
cargo test --workspace -- --test-threads=1       # everything, incl. the guards below
cargo test --test size_guard                     # core_has_no_native_deps_by_default, polis_deps_stay_lean, …
cargo test --test polis_store_guard              # Deref method-name guard (reads the store through tests/common)
cargo test --test poison_guard                   # the lock discipline, db.rs AND the store's modules
cargo test --test schema_golden                  # the DDL referee (87 rows)
UPDATE_GOLDEN=1 cargo test --test schema_golden  # only for a real migration
UPDATE_GOLDEN=1 cargo test -p redline --lib api_doc   # regenerate docs/api-v1.md after a ROUTES / ROUTE_TABLE change
REDLINE_REAL_DB=/tmp/real.db cargo test -p redline --lib real_db_attach -- --ignored --nocapture
REDLINE_REAL_DB=/tmp/real.db cargo test -p redline --lib real_db_gardener -- --ignored --nocapture
cargo tree -p polis-core --edges normal --depth 1   # serde, serde_json, sha2
```

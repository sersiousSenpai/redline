# Polis extraction — the ledger of what moved

Redline's memory system (the hash-chained prompt/decision lake, the
agent-organized class catalog, batched retrieval over both) is becoming
**Polis Memory**: its own local-first product, reachable over MCP, that
Redline imports like any other consumer. Program A of that plan is the
extraction, done one session at a time on the worktree branch
`feature/polis-extract`, with the crates staged under `src-tauri/crates/polis/`
until Session A7 lifts them into their own repo.

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

## Sessions ahead

| Session | Work | Gate |
|---|---|---|
| A6 | `polis-server`: router over `dyn MemoryApi` + `ROUTES` + ingest/`IngestObserver` + hook installer; Redline merges it, `auth.rs` shrinks by the 11 memory rows, `docs/api-v1.md` regenerates | drift + parity tests green |
| A7 | Guards (`core_has_no_native_deps_by_default`, `polis_deps_stay_lean`) + `git filter-repo` extraction → `polis-memory` repo; Redline on the git rev | Redline ≤ 27.4 MB from the git dep; new-repo CI green on 3 OSes |

## How to run what A1 added

```sh
cd src-tauri
cargo test -p polis-core                         # 41 tests, no I/O
cargo test -p polis-store                        # 9 tests: attach, adoption, WAL, cross-process append
cargo build -p polis-embed --features apple      # the on-device providers (macOS)
cargo test -p polis-llm --features anthropic,openai-compat   # every backend
cargo test -p polis-memory --features apple      # the facade, the handle's MemoryApi, the gardener's gates
REDLINE_REAL_DB=/tmp/real.db cargo test -p redline --lib real_db_gardener -- --ignored --nocapture
cargo test -p redline --test polis_store_guard   # Deref method-name guard
REDLINE_REAL_DB=/tmp/real.db cargo test -p redline --lib real_db_attach -- --ignored --nocapture
cargo test -p redline --test schema_golden       # the DDL referee
UPDATE_GOLDEN=1 cargo test -p redline --test schema_golden   # only for a real migration
cargo test --workspace -- --test-threads=1       # everything
```

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

## Sessions ahead

| Session | Work | Gate |
|---|---|---|
| A3 | `polis-store` methods in three commits by group; `record.rs`; `polis-embed` (`embed.rs` + `apple` feature) | green after each commit |
| A4 | `polis-llm` (`Agent`/`Usage`/`UsageSink`; `claude_cli` incl. moved `classify_line`/`StreamLine`; `codex_cli`; `anthropic`/`openai_compat` behind features) + Redline `polis_host.rs` | classifier/keeper/verifier pass through `Agent`; meter bookings unchanged |
| A5 | `polis-memory` facade: organize/verify over `&dyn Agent` + `HostResolver`, the retrieval half of `context.rs`, keeper memory passes as `gardener::step`, `bundle`/`mirror`, the `Polis` handle implementing `MemoryApi`, host-neutral `skills/classmemory/SKILL.md` | 20 keeper ticks on a real-DB copy behave as before |
| A6 | `polis-server`: router over `dyn MemoryApi` + `ROUTES` + ingest/`IngestObserver` + hook installer; Redline merges it, `auth.rs` shrinks by the 11 memory rows, `docs/api-v1.md` regenerates | drift + parity tests green |
| A7 | Guards (`core_has_no_native_deps_by_default`, `polis_deps_stay_lean`) + `git filter-repo` extraction → `polis-memory` repo; Redline on the git rev | Redline ≤ 27.4 MB from the git dep; new-repo CI green on 3 OSes |

## How to run what A1 added

```sh
cd src-tauri
cargo test -p polis-core                         # 41 tests, no I/O
cargo test -p polis-store                        # 9 tests: attach, adoption, WAL, cross-process append
cargo test -p redline --test polis_store_guard   # Deref method-name guard
REDLINE_REAL_DB=/tmp/real.db cargo test -p redline --lib real_db_attach -- --ignored --nocapture
cargo test -p redline --test schema_golden       # the DDL referee
UPDATE_GOLDEN=1 cargo test -p redline --test schema_golden   # only for a real migration
cargo test --workspace -- --test-threads=1       # everything
```

# Polis Memory — staging tree

This directory is the staging tree for the **`polis-memory`** repo: Redline's
memory system (the hash-chained prompt/decision lake, the agent-organized class
catalog, and batched retrieval over both) becoming its own local-first product
that anyone can install and reach over MCP, and that Redline then imports like
any other consumer. It is engineered and reviewed here, one crate per session,
and extracted to its own GitHub repo in Session A7 (`git filter-repo`, so the
crates keep their history). The program plan and the session table live in
`docs/polis-extraction.md`.

Same convention as `marketplace/`: the workflows under `.github/` here are
**inert while staged** (GitHub only reads workflows at the repo root), and the
`deny.toml` is the new repo's license gate, kept identical to
`src-tauri/deny.toml` so nothing copyleft can enter the graph on either side.

## Crates (publish order: core → store → embed → llm → server → mcp → memory)

| Crate | Session | What it is | Deps it is allowed |
|---|---|---|---|
| `polis-core` | **A1 · built** | PURE: ledger hashing + kinds + canonical event + chain verdict, the consume-once guards, the query planner, near-dup suppression, the proposal grammar, the coldness interlock, the answer-pack types/budget/fusion/render, bundle format + verifier, the deterministic gist, the tolerant JSON extractor, and the `MemoryApi` trait. Verifies a bundle without SQLite. | `serde`, `serde_json`, `sha2` — nothing else, pinned by a test |
| `polis-store` | **A2 + A3 · built** | rusqlite store: attach to a host connection or open standalone (WAL), its own migrations under `polis_meta` (never `PRAGMA user_version`), the lexical layer, the cross-process-safe chain append, and the ~120 memory methods (prompts, compaction, chain, search, catalog, supersessions, notes, observations, browse, embeddings rows, session tree, exports) | `polis-core`, `rusqlite` (bundled), `tracing`, `serde_json`, `flate2`, `regex-lite`, `uuid` |
| `polis-embed` | **A3 · built** (`apple`); C2 adds `model2vec`/`fastembed`/`openai` | `Embedder` trait, the on-device Apple backends (feature `apple`, macOS), vector cache, brute-force semantic search and the index tick — all taking an explicit embedder (provider SELECTION stays with the host); the pure vector math is `polis_core::vec` | `polis-core`, `polis-store`, `tracing`; `apple` → objc2 family |
| `polis-llm` | **A4 · built** | `Agent` trait + `Usage`/`UsageSink`; backends `ClaudeCli` (stream-json) and `CodexCli` (`exec --json`) by default, `AnthropicApi` and `OpenAiCompat` behind features; the `StreamLine` classifier every Redline surface reads with | `polis-core`, `async-trait`, `tokio` (process); features add `reqwest` |
| `polis-server` | **A6 · built** | `router<S>()` over `Arc<dyn MemoryApi>` (handlers take `State<PolisState>`; a host provides `FromRef`), the `ROUTES` table (24 rows, `Open \| HookContract \| Write(scope)`; source of `api-v1.md` and the generated clients), the capture route + `IngestObserver` seams, `CaptureHookSpec` (the hook installer); feature `standalone` = bind + token guard | `polis-core`, `axum`, `serde`, `tokio` (`rt`); `standalone` → tokio `net` |
| `polis-mcp` | E1 | rmcp server over `Arc<dyn MemoryApi>` (stdio + streamable HTTP) | `polis-core`, `rmcp` |
| `polis-memory` | **A5 · built** (E1 adds `cli`) | THE crate integrators add: `Polis` (borrowed view) + `PolisHandle` (owned, implements `MemoryApi`), retrieval (answer pack, timeline, map, tree/node views), the organizer and the gardener's `step` (organize, compaction, observations, the semantic index), bundle export, the markdown mirror, the `classmemory` skill | re-exports the four crates above; `apple` → `polis-embed/apple` |

What Redline links stays exactly what it links today: `polis-memory` with
`default-features = false` and the `gardener` + `embed-apple` features on
macOS. The `cli` feature is never enabled in Redline's graph (feature
unification would fatten the app — the documented `size.yml` hazard).

## Rules while staged

- **Byte-for-byte.** Moved code is the code Redline ran; a session may change
  a `crate::` path or a visibility, never a body. The referees:
  `tests/schema_golden.rs` (the memory DDL, in creation order) and
  `polis-core`'s pinned entry-hash vector.
- **Shims stay behind.** Every old module path (`crate::ledger::…`,
  `crate::classmem::…`, `crate::context::…`, `crate::bundle::…`,
  `crate::keeper::…`, `crate::query`, `crate::dedup`, `crate::db::BrowseHit`…)
  re-exports the moved item, so call sites compile unchanged and each session's
  diff is the move and nothing else.
- **Polis never depends on Redline.** `polis-core` is I/O-free by test; no
  crate here may name `redline_lib` (the same law `size_guard.rs` enforces for
  `redline-mcp`).
- **Worktree, never `git stash`.** Concurrent sessions edit the main tree
  live; extraction work lives on `feature/polis-extract`.

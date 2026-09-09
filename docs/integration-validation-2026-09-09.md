# Four-plan integration validation — 2026-09-09

A subsequent live upgrade exposed a historical schema-version collision that
the original fixtures missed. The repair and chat-progress follow-up are recorded
in [history-and-chat-repair-2026-09-09.md](history-and-chat-repair-2026-09-09.md).

This change integrates the four September 7 plans in one working tree. Provider
selection, executable resolution, launch metadata, model catalogs and restore
commands share one path. The native runner owns execution after plan review;
the localhost monitor independently owns development-server processes.

## Delivered behavior

| Plan | Result |
| --- | --- |
| Cursor and Antigravity planning | Native launch, hooks, review continuations, provider-specific restore and model/effort provenance. Antigravity is Preview. Discussions use separate Claude sidecars with an explicit read-only tool list. |
| Binary resolution and model catalogs | Codex candidates ranked by usable version, explicit overrides, executable identity cache invalidation, live Codex/Claude/native catalogs, configured-model readiness and model/effort-preserving restore. |
| Localhost Stop and Run | Stop identifies the bounded supervisor subtree, revalidates process identity and checks that the port stays closed. Run accepts known projects or a directory selected through Browse, with an editable command. |
| Orchestration v3 | Editable native graph, persistent scheduler, concurrent tasks, transactional file claims, independent checks/reviews, gates, steering, durable queue, recovery and measured reports. |

Work was split across provider/catalog, localhost and runner agents, with shared
protocol/UI integration and independent review. Review fixes include stale
catalog replies, concurrent Cursor hook ordering, retry invalidation, review
write barriers, queued-message delivery and attempt-scoped write claims.

## Automated verification

| Check | Result |
| --- | --- |
| `npm test -- --run` | 163 files; 1,954 tests passed. |
| `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml --workspace --no-fail-fast` | 1,228 tests passed; 10 ignored, including opt-in live/provider tests and a documentation example. |
| Final runner size reductions: `cargo test --manifest-path src-tauri/Cargo.toml --lib runner` with the same test environment | 41 tests passed; one opt-in live test ignored. Covers strict embedded schemas and single-use transaction callbacks with rollback. |
| `npm run build` | TypeScript and Vite production build passed. |
| `CARGO_INCREMENTAL=0 npm run tauri build` | Passed; produced `src-tauri/target/release/bundle/macos/Redline.app`. Its executable matches the freshly built release binary byte for byte. |
| `node scripts/check-size.mjs --strict` | Passed: native binary 35,987,600 / 36,000,000 bytes; boot JS 0.58 / 0.66 MB; total frontend assets 8.27 / 8.50 MB. Budgets unchanged. |
| API documentation golden | Regenerated and passed, including native provider routes and the runner attempt header. |
| `git diff --check` | Passed. |

The repository-wide `cargo fmt --check` still reports preexisting formatting
drift in unrelated modules. An unchanged `HEAD` copy of `agent.rs` reproduces
that failure. New Rust modules were formatted without rewriting unrelated files.

The final size reductions store fixed model schemas as JSON parsed once and
share the runner's transaction body across callback types. Native binary
headroom is 12,400 bytes under the existing ceiling.

## Executable and visual checks

- Cursor CLI `2026.09.08-6caf4ff`: captured native prompt/response/Stop hooks,
  a 35-second hold and seven follow-up generations. Captures show varying event
  order; a timed hold confirms response delivery while Stop remains held.
- Antigravity CLI `1.1.28`: captured a completed plan, revision, Ask continuation
  preserving the plan body, and approval. Transcript and hook fixtures cover the
  actual `NO_TOOL_CALL`/`PLANNER_RESPONSE` contract.
- Real Claude scratch run: structured decomposition, a draft graph edit, a Write
  through the HTTP claim guard with its attempt identity, persisted child
  session, independent shell check and measured `verified: true`.
- Disposable localhost servers: ordinary termination, supervisor respawn and
  SIGTERM-resistant escalation passed. Tests did not target existing user servers.
- Actual React components with production styling passed Playwright interaction
  checks: graph at 1366×768 and 760×900, and Run Project also at 390×700. Native
  IPC/events and Browse were stubbed, graph mutations were in memory, and Run
  asserted the selected path/command without spawning a terminal or server.

The native CLI cycles used disposable hook responders, not the packaged Redline
reviewer UI. Native restore is covered by command/adapter tests; the live captures
did not exercise its full handshake. No full packaged-app walkthrough is claimed.

Provider captures and compatibility boundaries are described in
[protocol-verification.md](protocol-verification.md). Runner lifecycle,
verification rules and configuration are described in
[native-runner.md](native-runner.md).

## Boundaries

Task execution currently uses Claude; the compatible structured-model endpoint
supports decomposition and review. Its usage is unavailable to native metering
and is not estimated. Node diffs show current uncommitted changes on claimed
paths, which can include edits that existed before the run. Antigravity plan
mode itself exposes write tools, so native-provider discussions use the separate
restricted Claude sidecar. CLI captures establish the tested local versions,
not cloud-agent or IDE-only compatibility.

All source changes remain uncommitted. Existing user changes were preserved.

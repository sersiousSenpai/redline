# Mission context and research handoff foundation

Research missions now persist a first research turn, explicit lifecycle checkpoints, source-linked Bookshelf artifacts, immutable context versions, monitoring definitions, attributed run findings, and user resolutions. A failed CLI start leaves the mission visible with a retryable error. Startup marks research and external runs interrupted instead of pretending they completed.

## Durable records and integrity

`mission_context.rs` adds `mission_records`, `mission_ingestions`, and a bounded `mission_derivatives` FTS5 index. Initialization is additive and idempotent. Existing mission tabs, model sessions, messages, findings, Polis events, and legacy bundle formats stay intact. Immutable context, artifact, and resolution rows reject updates and deletes at the database level.

Every foundation request carries its mission and workspace IDs. Research workspaces use the mission ID as their durable workspace identity. Mission prompts use `/v1/missions/:mission_id` and `/v1/missions/:mission_id/findings`, and continue addressing that owner after active workspace changes.

A published context includes the schema version, mission/workspace identity, publication time, source ledger head, exact artifact revision, permitted context scope, processing locality, asset availability, and SHA-256 hashes. The manifest hash commits to the manifest with an empty `manifestHash` and every asset's `content` set to null; asset hashes commit to the actual content. JSON objects serialize with sorted keys, compact separators, and UTF-8. Published assets use available, omitted, expired, or redacted status. Missing artifacts are explicitly omitted. Runs receive only their selected asset bodies plus the verifiable manifest.

An export wraps the existing verified Polis bundle in `redline.mission-bundle.v1`. It does not rehash or reinterpret historic ledger events. The independent Python consumer verifies the new manifest and selected assets; Polis retains its existing verifier for the embedded ledger bundle.

## Monitoring and review

The mission workspace offers **Create monitoring bot**, a 12-firm Securities Dev reference, pinned/following published context, cadence/time zone, reviewed source hosts, read/fetch/snapshot actions, and a local processing preference. A definition prepares recurring work for a compatible runtime. This change does not provision a scheduler or a fleet of computers.

A run atomically records its concrete context version, selected asset hashes, model/provider identity, execution environment, credential references, action/time budgets, checkpoints, and source coverage. A second start with the same bot/run key returns the existing run. Overlapping or interrupted runs block a new run until reconciled. Provider changes cannot broaden tools/hosts or send local-only context to a remote model.

Findings require dated source excerpts and scoped source hosts. The stable finding fingerprint deduplicates repeated announcements across publishers and runs, while retaining newly returned source observations. Agent findings remain proposed. A failed source requires a partial-coverage report rather than a completed claim.

The gardener stores observations and a bounded queue of consequential questions. User actions **confirm**, **correct**, **defer**, and **dismiss** append resolutions through the existing Polis ledger. Records retain observation/question IDs, explanation, resolving actor, observed/resolved times, scope, source references, supersession links, and preceding/current ledger hashes. Retrieval returns current confirmed/corrected understanding plus provenance. Deferral preserves uncertainty; dismissal does not classify the source as irrelevant. The current gardener creates explicit questions from submitted observations and findings; it does not infer user intent from navigation.

## Capture adapter and bounds

The installed adapter records short sequences of native WKWebView screenshots around navigation and source-linked pins. Capture is disabled by default. The user selects mission tabs and can pause or disable capture. A recording contains up to eight timestamped PNG keyframes, sampled at one-second intervals over at most seven seconds. Consecutive identical frames are deduplicated. The panel provides frame selection and playback, recognized text, extraction failures, and explicit text-processing retry. These are keyframe recordings, not an HEVC/video stream.

Every frame checks current global/mission exclusions, selected-tab enrollment, visibility, URL, document identity, and before/after page revision. A page change stops the recording; an initial screenshot without revision proof is recaptured and checked. Actual PNG bytes are retained under immutable content-addressed keys, independent of the older DOM-addressed screenshot. Final policy, queue, and storage admission occurs in the same write transaction before the first recording file is copied. Ten-second per-tab cooldown and two concurrent intake slots coalesce bursts before additional native capture. A single background recording/extraction worker and a 20-job active queue apply backpressure. The UI uses a 64 MB mission storage budget and seven-day retention; lower configured duration bounds are honored. Configuration hard ceilings remain 30 seconds, 256 MB, and 30 days.

Apple Vision recognizes text locally on the background worker. Each frame records actual extractor/request revision and macOS version, normalized text regions, and OCR confidence. Its structural summary reports visible text and region counts; it does not claim semantic interpretation of charts or pictures. The accompanying DOM text is separately labeled. Native OCR accepts at most 8 MB/16 megapixels per frame, returns at most 8 KB of text and 256 regions, and requests cooperative cancellation after five seconds. The worker checks a 15-second segment processing budget between frames. Combined indexed text is bounded to 32 KB. No remote model, downloaded model, shell service, or executable dependency is introduced.

Frame lists and per-frame extraction checkpoints are durable. Restart and retry process retained frames; they never revisit a historical page to recreate missing footage. Paused work resumes after scope is enabled again. Failed OCR remains visible and retry preserves successful frames. Exclusions are checked again after slow OCR and inside the checkpoint/index transaction. Detail, frame, and text-search reads enforce current exclusions and selected scope; reviewing earlier evidence remains possible while capture is paused or disabled. Forgetting an original picture retires its copied recording references, and expiry removes all frame text, regions, searchable derivatives, and media references. The global screenshot sweeper protects all retained frames and skips deletion if reference lookup fails. Published context contains capture metadata and references, excluding regenerable OCR/DOM/summary bodies.

[The capture evaluation](capture-performance-2026-09-13.md) compares the existing screenshot path with Retrace's actual Swift interfaces at a pinned upstream revision. Retrace exposes capture streams and processing/storage protocols, but its screen/app capture scope and internal module dependencies do not provide a supported Redline tab-scoped service boundary. The selected adapter uses WKWebView snapshots and the same native Vision capability directly. A live Retrace service, encoded video, semantic image descriptions, and embedding generation are not shipped by this adapter; the interfaces retain extractor/embedding-provider version fields for future integrations.

## Handoffs

Mission synthesis persists a Bookshelf document, its source records, an immutable artifact revision, and a prepared delivery before emitting the UI event. Retrying the same synthesis key returns the same document. **Continue as…** provides an editable brief and then uses existing model/project/launch readiness.

Plan and auto launches claim a prepared handoff atomically. A receipt records the concrete destination ID and the claim token. Concurrent clicks cannot launch twice. An uncertain launch remains uncertain, including after restart; automatic replay is blocked. Drafter delivery opens the already-created document.

`conversation_prepare_handoff` also preserves browse, linked, companion, and Drafter conversation identity and exact selected message boundaries. It writes source-message links and an artifact without creating a synthetic mission. Its `scopeId` supports the same retrieval/claim/delivery operations, while rejecting research and bot mutations. Historic messages retain their roles so assistant suggestions are not silently promoted to user decisions.

## Headless conformance workflow

The synthetic 12-publisher fixture is `fixtures/mission/securities-dev.json`. It includes repeated announcements, an unverified filing/deadline, a failed source, partial coverage, and a correction for the next published context. No fixture issuer or deadline is current legal information.

The Rust fixture creates successive versions, runs a bot with a pinned starting version, records a user correction, publishes a new version, changes the simulated model/computer, and verifies subsequent context adoption and idempotent ingestion. It also checks old hash preservation, tampered assets, workspace isolation, deferred uncertainty, shared-shot deletion, cross-language verification, and launch ownership.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib mission_context::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib mission_contracts::tests
python3 scripts/mission-reference-consumer.py --verify /path/to/exported-context.json
```

For an explicit headless simulated run, first create a mission and publish context. Create a bot with the fixture's definition and the published `versionId`. Supply the daemon's existing credential reference through the environment, then run:

```sh
python3 scripts/mission-reference-consumer.py --run --mission MISSION_ID --bot BOT_ID --run-key fixture-day-one
```

The consumer uses the protected `/v1/missions/:mission_id/foundation` endpoint. Every operation, including `read`, `resolve`, and `export`, requires the existing daemon master token or an extension token granted `memory.write`; the consumer reads this credential from `REDLINE_DAEMON_TOKEN`. Mission summary, findings, and tab GET routes retain the existing open-read contract. Opening scoped tabs and typed browser actions require the separate `browser.drive` scope. HTTP rejects user-only publication, configuration, confirmed judgments, and handoff operations even with a token; those remain in the desktop controls. The consumer verifies the resolved context, submits two publishers' matching fingerprints, checkpoints progress, and records partial coverage. Repeating the run key returns the existing terminal run. It never asks the daemon to confirm judgments or widen bot permissions.

Measured enabled/disabled local OCR and interface results, memory/CPU observations, storage accounting, methodology, and raw results are in [the capture performance report](capture-performance-2026-09-13.md). The ignored `capture_interface_microbenchmark` separately reports p50/p75/p95 and logical SQLite allocation for 100 simulated admission/persistence/FTS samples. Its mock pixel-byte total is not real image storage growth. The native OCR fixture establishes local extraction performance; neither fixture establishes a navigation-latency claim. A capture-enabled/disabled native browser walkthrough remains an explicit validation limitation until measured.

## Reference publisher sources

The UI source template was checked against these official sites on 2026-09-13: [Robbins Geller](https://www.rgrdlaw.com/), [Robbins LLP](https://robbinsllp.com/), [Glancy](https://www.glancylaw.com/), [Pomerantz](https://pomlaw.com/), [Rosen](https://www.rosenlegal.com/), [Hagens Berman](https://www.hbsslaw.com/), [Faruqi & Faruqi](https://faruqilaw.com/), [Schall, Brown & Schwartz](https://schallfirm.com/), [Bernstein Liebhard](https://www.bernlieb.com/), [Levi & Korsinsky](https://zlk.com/), [Bernstein Litowitz](https://www.blbglaw.com/), and [Scott+Scott](https://scott-scott.com/). The mandate requires each real runtime to check source coverage, dates, and current page structure afresh.

Production scheduling, independently provisioned computers, a packaged installable runtime, and actual model post-training remain subsequent work. Curated-example export records user-confirmed examples for future evaluation; it does not alter model weights.

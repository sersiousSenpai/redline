# Mission capture: integration review and performance evidence

The implementation uses Redline's existing native webview snapshot path and local Apple Vision OCR. Retrace was evaluated as an integration candidate; it was not installed, launched, or enabled. This report separates synthetic admission/index costs, native OCR costs, and the still-unverified cost of capturing live browser activity.

## Retrace interface review

The upstream source inspected on 2026-09-13 is [`haseab/retrace` at `621d762df9dafe9de078c36522b451d45a74f941`](https://github.com/haseab/retrace/tree/621d762df9dafe9de078c36522b451d45a74f941). No pre-existing Retrace application or checkout was found in the standard system/user Applications folders, the user's top-level folders, Downloads, Redline checkout, or its standard Application Support location. Two small local Redline search-cache files contained search-result envelopes, not an installed capture package. Only selected upstream text source files were downloaded to `/tmp/redline-retrace-source-audit` for inspection; no package build, dependency install, permission request, capture process, or configuration change occurred.

The README describes a macOS screen-capture application with local Vision OCR, deduplication and HEVC segments. It explicitly identifies semantic embeddings as prepared but inactive. Its performance/storage figures are upstream claims and are not Redline measurements. [Pinned README](https://github.com/haseab/retrace/blob/621d762df9dafe9de078c36522b451d45a74f941/README.md).

| Boundary | Verified upstream interface | Implication for Redline |
|---|---|---|
| Capture | Actor-based `CaptureProtocol`: permission checks, start/stop, configuration updates and an asynchronous stream of captured frames | A Swift integration boundary exists. It is not a stable external HTTP, command-line, C ABI or JSON service contract. |
| Scope | `CaptureManager` selects the active display; configuration supports app exclusions, private-window patterns, intervals, resolution and redaction patterns | A selected Redline native webview/tab is not an upstream capture scope. Starting its normal capture loop would widen the task's scope. |
| OCR | `ProcessingProtocol` extracts frame text; `OCRProtocol` accepts image bytes, dimensions, stride and processing configuration | Admitted Redline frame pixels could feed a version-pinned Swift bridge. OCR can be used without enabling Retrace's capture loop. |
| Video | Storage creates a segment writer; writers append frames, expose flushed-frame counts, finalize or cancel; storage reads frames and deletes segments | A bounded admitted-frame sequence could feed an optional encoder. Redline would still own policy, mission identity, duration/bytes, cancellation and retention. |

Sources: [Capture protocol](https://github.com/haseab/retrace/blob/621d762df9dafe9de078c36522b451d45a74f941/Shared/Protocols/CaptureProtocol.swift), [capture implementation](https://github.com/haseab/retrace/blob/621d762df9dafe9de078c36522b451d45a74f941/Capture/CaptureManager.swift), [configuration](https://github.com/haseab/retrace/blob/621d762df9dafe9de078c36522b451d45a74f941/Shared/Models/Config.swift), [processing protocol](https://github.com/haseab/retrace/blob/621d762df9dafe9de078c36522b451d45a74f941/Shared/Protocols/ProcessingProtocol.swift), [storage protocol](https://github.com/haseab/retrace/blob/621d762df9dafe9de078c36522b451d45a74f941/Shared/Protocols/StorageProtocol.swift).

The package publishes Swift libraries. However, its Processing target depends on Database, Storage and Search; Database uses SQLCipher. Importing that target is therefore broader than a small standalone Vision call. The inspected package does not establish a supported external bridge that Redline can invoke directly. [Package manifest](https://github.com/haseab/retrace/blob/621d762df9dafe9de078c36522b451d45a74f941/Package.swift).

**Adapter decision:** retain native `thumbs::capture_shot` for the admitted webview, with Redline-owned scope checks before capture and local OCR afterward. A future Retrace adapter can consume already-admitted frame bytes for OCR or segment encoding. It must declare its supported scope, receive mission/tab/source IDs and policy revision, accept a cancellation token and byte/time budget, and return timestamped frame hashes, derivatives, confidence and extractor/model versions. It must reject unsupported tab scope rather than substitute whole-display capture. These are requirements for a future bridge, not a claim that a Retrace service has been integrated.

## Measurement environment and boundaries

Reference machine: Apple M3 Max, 48 GiB RAM, macOS 14.3, arm64, rustc 1.95.0. The microbenchmarks run on synthetic fixture data. No real browsing, desktop images, personal application content or application database is used.

The admission/index test uses a fresh in-memory database. Disabled admission and enabled admission plus persistence/FTS are measured separately over 100 operations. Its mock `pixels-i` inputs are not PNG captures. Logical SQLite page allocation and mock input bytes must not be presented as real recording storage.

The OCR test loads one generated PNG containing known text. A disabled process references the same embedded fixture without decoding or recognition; an enabled process reports the first recognition separately and then 100 measured recognitions. The first call is process-first, not proof that operating-system/model caches are cold. `/usr/bin/time -l` measures the already-built test executable, excluding Cargo and compilation. Its user/system CPU and peak RSS include Rust test-harness and Apple framework initialization; they are not the running Redline application's CPU or memory.

The measurement driver is [`scripts/capture-performance.py`](../scripts/capture-performance.py). It preserves raw stdout/stderr and structured results, checks that both benchmark tests exist, accepts at most 100 iterations and 10 batches, and requires a new output directory. Default execution is three batches of 100 observations per mode. Example after the current native tests have been built:

```sh
python3 scripts/capture-performance.py \
  --test-binary src-tauri/target/debug/deps/<confirmed-Rust-test-executable> \
  --iterations 100 --batches 3 \
  --output-dir /tmp/redline-capture-measurements
```

The supplied executable must contain `mission_context::tests::capture_interface_microbenchmark` and `capture_ocr::tests::ocr_fixture_microbenchmark`; use `--ocr-test` if its name differs. The driver runs only those ignored synthetic benchmarks and never launches Redline or enables capture.

## Results

All nine benchmark processes passed: three batches each of disabled OCR, enabled OCR, and the combined admission/index test. Heavy native builds and foreground tests were paused during the measurement window. This final-source run supersedes the earlier `-01` run, preserved in `/tmp/redline-capture-measurements-20260913-01`, because admission/index policy checks and transactions changed. The exact command was:

```sh
python3 scripts/capture-performance.py \
  --test-binary src-tauri/target/debug/deps/redline_lib-34ba914a9ea22570 \
  --iterations 100 --batches 3 \
  --output-dir /tmp/redline-capture-measurements-20260913-02
```

The numerical observations, command, fixture, source and executable hashes are preserved in [capture-performance-results-2026-09-13.json](capture-performance-results-2026-09-13.json). Raw process stdout/stderr remain in the output directory above. These are debug-profile measurements of the compiled helpers, not release application timings.

### Local OCR

The [generated fixture](../fixtures/mission/ocr-reference.png) is 1200×300 pixels, contains three known text lines, and occupies 31,225 PNG bytes. Each recognition returned three regions and 773 bytes of serialized derivative data. There were zero errors in 300 measured recognitions and three process-first calls. Extractor: `redline-apple-vision-ocr-v1`; model identity: `Apple Vision VNRecognizeTextRequest revision 3; Version 14.3 (Build 23D56)`.

| Batch | Process-first call | Warm p50 | Warm p75 | Warm p95 | Process user CPU | Process system CPU | Peak process RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1659.91 ms | 46.60 ms | 47.40 ms | 48.72 ms | 3.58 s | 1.49 s | 352.75 MB |
| 2 | 1642.08 ms | 46.86 ms | 47.64 ms | 48.63 ms | 3.57 s | 1.50 s | 354.44 MB |
| 3 | 1739.97 ms | 47.32 ms | 48.53 ms | 59.45 ms | 3.78 s | 1.44 s | 364.36 MB |

Each CPU/RSS row covers a fresh test process, its first recognition and 100 subsequent recognitions. Enabled process elapsed time was 6.73–6.96 seconds. Disabled fixture-only controls performed no decode or recognition; each consumed 0.10 seconds user CPU plus 0.33 seconds system CPU, 0.44–0.45 seconds elapsed and 15.55–16.17 MB peak RSS. MB denotes decimal megabytes; exact bytes are preserved in the JSON. Its nearly empty iteration timings are timer-floor observations, not disabled application-navigation timings.

The roughly 337–349 MB difference between enabled and disabled process peaks is a reason to keep OCR concurrency bounded and off the UI path. Peak RSS does not establish retained app memory. This sparse fixture does not establish OCR latency or accuracy for dense pages, low-contrast screenshots, charts or multiple languages.

The 31,225-byte PNG and 773-byte derivative are observed representation sizes. The benchmark does not persist 100 screenshots or derivatives, so it does not claim that an enabled recording grows storage by their sum on every sample. The segment pipeline's deduplication, retention, metadata, PNG content and frame count determine actual storage growth; a live shot-store comparison remains pending.

### Admission and indexing

Each batch uses a new in-memory database with 100 disabled admissions followed by 100 enabled admissions, metadata persistence and FTS indexing. All assertions passed.

| Batch | Disabled p50 | Disabled p75 | Disabled p95 | Enabled p50 | Enabled p75 | Enabled p95 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 13 μs | 13 μs | 14 μs | 785 μs | 1039 μs | 1201 μs |
| 2 | 13 μs | 13 μs | 14 μs | 764 μs | 1000 μs | 1194 μs |
| 3 | 13 μs | 13 μs | 14 μs | 771 μs | 996 μs | 1198 μs |

Each batch's SQLite allocation, measured as `page_count × page_size`, grew from 1,159,168 to 1,261,568 bytes: **102,400 bytes** for 100 enabled operations. This is logical page allocation in an in-memory fixture database, not disk writes, WAL growth or captured-media storage. Each batch recorded 890 simulated input bytes, the sum of `pixels-i` values.

These enabled timings exclude snapshot capture and OCR. Process user/system CPU was 0.27/0.33 seconds and elapsed time 0.61 seconds for each batch; peak RSS was 26.26–26.39 MB, including schema/fixture setup and harness startup. All three batches now report p50, p75 and p95 for both modes. No whole-app recording latency or storage rate is inferred from these synthetic operations.

## Live-workflow verification

Native Computer Use failed to start on three attempts during this session. No capture-enabled versus disabled browser-navigation p95, tile-focus timing, recording walkthrough, or whole-app CPU/RSS measurement is claimed.

The remaining live comparison must use the same local fixture page and saved policy, with capture off/on in alternating batches, at least 100 navigations per condition, and recorded browser/window size, tile count, selected scope, frame interval and processing limits. Measure navigation independently from background capture/recognition/index completion, record queue depth and errors, and measure actual shot-store plus database growth. Exercise pause, exclusions, scope changes, byte limits, processing cancellation, restart recovery and pruning before claiming end-to-end parity. These pending observations do not invalidate isolated OCR or admission timings, but those timings cannot substitute for the live comparison.

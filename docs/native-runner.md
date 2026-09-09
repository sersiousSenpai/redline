# Native run graphs

Orchestrate prepares an editable draft in the existing Runs → Live tab. It does
not launch a terminal or a vendor Workflow. Review the tasks, dependencies,
models, scope hints and check commands, then choose Run. Approve for queue
marks the same graph ready for an overnight pass.

The backend is `runner_graph.rs` (pure schema/reducer/readiness), `runner.rs`
(process lifecycle and commands), and transaction methods in `db.rs`. Schema
version 2 adds separate `run_graphs`, `run_nodes`, `run_edges`, and `run_claims`
tables. `work_items` remains a backlog with provenance, never process ownership.
The JSON document, normalized rows and revision update in one transaction.

## Execution and verification

Tasks run Claude CLI turns, retain their child session for resume, and share one
working tree. The task surface provides direct read/write tools; shell commands
run in check nodes so shell mutation cannot evade file claims. Per-child
PreToolUse settings post every Edit/Write/NotebookEdit attempt to the loopback
claim service. Writes fail closed if it is unavailable. Real canonical paths,
including symlink resolution, determine ownership; `.git` and paths outside the
repository are excluded. Scope hints only influence scheduling unless explicitly
enforced. Released claims retain their history.

Checks measure shell exit codes and capture both stdout and stderr. Their
coverage is the union of real task-predecessor claims. A running scoped check
vetoes writes to those paths; a global check waits for all live tasks and vetoes
all task writes. Failed prerequisites never unblock downstream nodes. A failing
check with exactly one task ancestor resumes that task with the check output,
up to its attempt limit. Multiple possible makers or exhausted attempts wait for
a human; the scheduler does not guess attribution.

Review nodes make a clean-context, tool-free structured PASS/FAIL call over the
brief and current uncommitted diff. They never reuse a task session. Gates are
durable waiting rows. Approving a gate resumes a pause created by that gate;
manual pauses, Stop and restart recovery remain explicit human decisions.

Steer delivers a message to the running task's streaming stdin. Queue persists
a follow-up for its next turn. Stop signals the owned process group and awaits
termination; background descendants cannot keep a finished node's pipes open.
Node timeouts are three hours; structured model calls time out after three
minutes. Restart pauses interrupted runs, preserves resume IDs and live claims,
and marks interrupted nodes awaiting human action. It never treats an old PID
or terminal tab as proof that a task is still running.

A completed task is independently verified only if all its downstream
check/review nodes passed and every machine check recorded exit code zero.
Measured reports include command output and per-attempt meters; they reuse the
existing plan report and unresolved-work filing paths. Node diff inspection
filters the current working-tree diff by actual claims; it is not an isolated
snapshot and may include preexisting changes to those paths. Runs continue to
leave all changes uncommitted for the existing review surface.

The overnight queue executes only graphs explicitly marked ready. An old queue
entry without a graph produces a draft for review. A parked or partial dirty
tree stops that repository's dequeue loop so the next plan cannot mix its edits
into the same unreviewed diff. Other opted-in repositories proceed independently.

## Structured model provider configuration

The default `ModelBackend` uses Claude's tool-free `--json-schema` mode and reads
`structured_output`, with `meter.rs` doing all usage accounting. An optional
`app_settings` value under `redline.runner.modelBackend` selects a compatible
chat-completions endpoint for decomposition and independent review:

```json
{"endpoint":"http://127.0.0.1:1234/v1/chat/completions","model":"local-model","apiKeyEnv":null}
```

For an authenticated gateway, `apiKeyEnv` names an environment variable; secrets
are never stored in the graph or emitted to the canvas. The endpoint must support
JSON-schema response format. Gateway usage is currently unavailable to the native
meter and is not fabricated. Task execution remains Claude-only; `TaskBackend`
and its capability record are the seam for a future resumable harness.

## Local verification

`CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --lib runner` covers shared Rust/TypeScript graph
fixtures, stale revisions, atomic claims, concurrent conflicts, check barriers,
scope enforcement, retries, measured verification, disk restart, effort
persistence and real disposable check subprocesses. The canvas pure-core suite
reads the same JSON fixtures under `src/lib/runner/fixtures`.

Historical Workflow reconstruction stays in History. The old executor prompt is
archived in `orchestration-v2-legacy.md`; native nodes use skill version 3.

The opt-in `native_claude_scratch_smoke` acceptance test was run with the installed
Claude harness: it generated a structured graph, applied a draft edit, created a
scratch file through the real Write/PreToolUse claim path, retained the child
session, ran its independent shell check, and derived `verified: true` from exit
code zero. It uses a disposable loopback claim service and removes its scratch
repository. Run it explicitly with `--ignored --test-threads=1`; it consumes the
user's Claude subscription and stays excluded from ordinary test runs.

Reviews read the current repository diff and therefore hold a global write barrier, even when `checkGlobal` is false. Both ready-node selection and first-write claims enforce it. Automatic task retries invalidate every downstream result; a still-running descendant instead pauses the failed check for human intervention.

Retry or Queue on a completed task reopens its completed run in a paused state for explicit Resume. The old downstream verification, report resolution, and review-to-plan link are invalidated before rework. Messages queued during child startup remain durable for the next turn; delivery acknowledges only the prefix reserved for that attempt.

Each spawned writer sends its immutable `REDLINE_RUN_ATTEMPT` as `x-redline-run-attempt` with every claim. The database compares it with the active node attempt inside the claim transaction. A late hook or surviving child from a previous attempt cannot regain write permission after recovery and Retry. Missing attempt metadata fails closed.

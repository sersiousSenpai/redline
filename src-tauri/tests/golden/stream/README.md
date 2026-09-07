# stream-json fixtures

Real `claude -p --output-format stream-json --include-partial-messages
--verbose` stdout, captured 2026-09-04 against `claude` CLI **2.1.222** for the
token/provenance meter (`meter.rs`). Recorded as **Experiment (j)** in
`docs/protocol-verification.md`.

Every capture ran in a throwaway scratch directory containing one small
`NOTES.md`, with `--strict-mcp-config` and the `CLAUDE*` environment stripped.
Redaction: session ids replaced with stable placeholders, `$HOME` rewritten to
`/tmp/home`, `cwd` to `/tmp/spike`, the thinking `signature` blob replaced, and
the `init` line's local-config arrays (`skills`, `slash_commands`, `plugins`,
`agents`, `memory_paths`, `mcp_servers`) truncated to two entries. Nothing else
was touched — the protocol shapes are verbatim.

- `turn_thinking_tools.jsonl` — **the reference capture.** Sonnet at
  `--effort high`, two tool calls (Read, Grep), one thinking block. Carries
  every shape the meter reads: `system/init`, `system/status`,
  `system/thinking_tokens`, `rate_limit_event`, `message_start`,
  `content_block_start` (thinking / tool_use / text), `thinking_delta`,
  `signature_delta`, `input_json_delta`, `text_delta`, `message_delta`,
  cumulative `assistant` snapshots, tool_result `user` lines, and the terminal
  `result`.
  Authoritative totals (`result.usage`, which the per-message fold reproduces
  exactly): **in 6 / out 319 / cache_creation 5,983 / cache_read 30,186**;
  context high-water **12,256**; 2 tool calls; `stop_reason: end_turn`.
- `turn_minimal.jsonl` — `--tools ""`, no thinking, one text block. The floor
  case. Totals: in 2 / out 4 / cc 5,476 / cr 3,289; context high-water 8,767.
- `turn_resume_error.jsonl` — `--resume` against a nonexistent session. A
  **single** `result` line: `is_error: true`, `subtype:
  error_during_execution`, an `errors[]` array, and `usage` **all zeros**.
  This is why `meter::observe` adopts `result.usage` only when it is non-zero:
  a mid-turn API failure really did spend the tokens the live fold already
  counted, and overwriting them with zeros would under-report.

Two fixtures are **hand-authored**, not captured, and are named to say so:

- `synthetic_max_tokens.jsonl` — a truncated reply. The CLI exposes no
  `--max-tokens` flag, so this case cannot be provoked from the command line;
  the shape is copied verbatim from the verified `message_delta` /
  `result` shapes above with `stop_reason` set to `max_tokens`.
- `synthetic_rate_limited.jsonl` — a rate-limit event whose `status` is
  **not** `allowed`. Every real capture emitted a `rate_limit_event` with
  `status: "allowed"` — it is a routine per-turn heartbeat, not a stall — so
  the interesting case had to be authored. `resetsAt` is unix **seconds**.

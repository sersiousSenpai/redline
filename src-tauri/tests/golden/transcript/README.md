# transcript fixtures

- `agent_head.jsonl` — the head of one real Claude Code agent transcript
  (prompt line, an attachment line, thinking/tool_use/text assistant lines,
  tool_results; the two largest attachment lines were dropped). Consecutive
  `assistant` lines repeat one `message.id` with cumulative usage, which is
  what `meter.rs` and `plan_meter.rs` pin their dedupe tests on.

# runwatch fixtures

Copied 2026-08-07 from a real Workflow run (`wf_c82ac4f1-bc0`, an orchestrated
plan executed in an external project) under
`~/.claude/projects/-Users-yusufalbazian-securitieslist-beta/1fa67bd8-6835-4cf7-9d2d-94234c0835df/`.

- `parent_launch_line.jsonl` — the parent transcript line whose tool_result
  announces Run ID / Transcript dir / Script file / Task ID (verbatim).
- `journal.jsonl` — the journal's first 9 lines (leaves `a0f67ee297c91d36b` as
  an unpaired `started`), plus a SYNTHESIZED tail: a result-only (cached)
  agent, a started+error-result pair, and one malformed line.
- `agent_head.jsonl` — head of one agent transcript (prompt line, an
  attachment line, thinking/tool_use/text assistant lines, tool_results);
  the two largest attachment lines were dropped.
- `script.js` — the persisted workflow script, verbatim.
- `manifest.json` — the real completion manifest; only its embedded `script`
  field was truncated (the full script is `script.js`).
- `meta_workflow.json` — a workflow subagent's `.meta.json` (no description).
- `meta_sequential.json` — a sequential-fallback subagent's `.meta.json`
  (carries `description`), from a Redline-project session.

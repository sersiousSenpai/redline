# Chat steering transport reference

Measured on October 6, 2026, in a disposable directory; no project files were edited. The scratch harness is `/tmp/redline-chat-steer-spike/spike.py`, with raw stdout/stderr beside it.

Claude: spawned print mode with stream-json input/output, partial messages, and a permitted `sleep 8` tool. A second user frame was written after the tool-use frame. The update was folded into the same turn: **one result**, one session ID, `num_turns: 2`, `queued_turn_count: 0`. The final answer was “SECOND” and explicitly acknowledged that the instruction arrived during the sleep. The harness continued reading for twelve seconds after that result; no second result appeared.

Codex: initialized app-server, started a workspace-write thread in the disposable directory, and sent `turn/steer` during a `sleep 8` command using the acknowledged `expectedTurnId`. The response acknowledged that same turn ID; the stream ended in one `turn/completed`. The adapter may therefore enable scoped workspace-write and live steering. A protocol rejection must leave the queued row available for interrupt-and-send.

Reader contract: warm Claude returns to the pool after the single result. Cold turns, mode changes, unavailable controls and rejected Codex steering use the existing interrupt-and-send queue drain. Reservation tokens own control slots. The UI labels an interrupted steer honestly. Deliveries split the stored assistant stream before inserting the queued user row, retain the monotone sequence watermark, and record the prompt in the ledger only at delivery.

This spike verifies mid-tool injection, not arbitrary late-arriving CLI frames or a graphical hosted/TUI handoff. Those require separate shell protocol verification.

# Flow shell: whole-app captures against the boards

From `node scripts/flow-app-visual-qa.mjs --theme aurora,basic,studio --shell flow,classic --keep-going` on `integrate/flow` (2026-10-18, after every lane merged). Each `<board>-compare.png` shows three panels: the board, the flow shell in Aurora, and their difference (black means identical). The Basic and Studio captures, the classic captures and `report.json` are in the run's `--out` directory; they can be regenerated, so they aren't committed.

| | Flow (each theme) | Classic |
|---|---|---|
| Console errors | 0 | 0 |
| Contrast shortfalls | 0 | the same as before Flow (37 across 15 runs) |
| Probes passing | 4a 8/15 · 4b 7/13 · 4c 12/15 · 4d 3/9 · 5a 11/18 | not expected to match the boards |

The flow probes that fail are the known deviations, not defects:

- **The composers carry mic and Talk** (plan deviation 2: voice stays one click away).
- **Tools has extra rows.** It has a Terminals row, and a third section for the utilities classic kept in its header (palette, Join a live session…, Memory inspector), so switching shells loses nothing.
- **The ⋯ shows on every sidebar row.** The plan says always visible; the boards show it on the active row only. This is open for the GUI walk.
- **Serif:** `--font-serif` resolves to New York, which is heavier than the boards' Source Serif 4. This is open for the GUI walk.
- **Scenario data:**
  - 4a's strip is hidden because the seeded sessions are approved;
  - 5a's anchors read "Plan" because the drawn plan has no §4;
  - 4c has 1 mark where the board has 2;
  - "Reopen plan" is hidden during a live run (classic's rule).

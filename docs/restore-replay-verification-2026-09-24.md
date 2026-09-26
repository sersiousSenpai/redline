# Restore wording replay — 2026-09-24

The restore text now explains that the user clicked Restore, where the model can verify the integration, why the plan file contains a marker, and that Redline preserves the plan, comments, and discussions. Both visible prompt variants reassure that nothing is lost. The installed contract advances to version 15, and a Rust regression pins the described send-back prefix to the real feedback denial.

The isolated replay is **weak evidence, not a validated fix for the observed refusal**. [Aggregate results](restore-replay-results-2026-09-24.json) contain no incident transcript text.

| Wording | Main trials | First attempted tool | Write/Edit attempts | Captured restore handshake |
| --- | ---: | --- | ---: | ---: |
| Old | 5 | ExitPlanMode in 5/5 | 0 | 0 |
| New | 5 | ExitPlanMode in 5/5 | 0 | 0 |

Every main trial resumed a new UUID copy of transcript records 0–192, replaced the plan path with a scratch marker file, and used `claude-sonnet-5` with `xhigh` effort. `CLAUDE*` and `REDLINE*` environment variables were removed. Only project-local permissions were loaded, MCP configuration was empty and strict, and explicit hooks supplied the old/new additional context and denied mutation attempts. No Redline daemon hook was loaded, and no request reached the real review.

Claude Code 2.1.282 in print mode excluded `ExitPlanMode` from the available tool set. The model's attempted call failed as disabled before the capture hook could run. A further control trial per variant using the default tool inventory confirmed that restriction: the old variant attempted the unavailable tool, and the new variant explained its unavailability without trying. These are tool-availability failures, not reproduced prompt-injection refusals.

The old wording never reproduced the incident's refusal, so these trials cannot establish an improvement in refusal rate. The original plan's requested live interactive restore remains unverified. All synthetic transcripts, scratch plans, replay outputs, and scratch programs were removed after retaining these aggregate measurements. No live plan file, hook configuration, or saved review was changed.

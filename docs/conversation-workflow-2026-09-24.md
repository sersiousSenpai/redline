# Conversation workflow and discussion recovery

Implemented from the three conversation/discussion plans dated 2026-09-24. Existing uncommitted changes were retained. The coordinating integration run subsequently built, verified, installed and launched the combined application; source changes remain uncommitted. See the [aggregate completion report](twelve-plan-implementation-2026-09-24.md).

## Implemented behavior

| Plan area | Result |
| --- | --- |
| Independent panel masks | Sidebar and comment pane have separate in-memory breaks. Terminal gestures cannot lift them. Automatic comments/plan arrivals update pane preference; masked surfaces receive a Review toast. |
| Scoped conversation column | Home, plans, Drafter and browser retain separate visibility. Leaving Home closes Home. Cmd-J is inert where no conversation exists. |
| Home owns Chat | No Companion tab on other surfaces, no browser-carried chat, no docked/collapsed chat pose. Chat mounts only while Home is open or a seed is pending. Obsolete handoff protocol removed. |
| Direct Chat → Plan | One-shot Chat/Plan composer mode and Cmd-Enter prepare the sourced brief, preserve final instruction as Objective, resolve the per-chat repo, and launch without a dialog. Other destinations remain under More. |
| Handoff lifecycle | Receipt shows starting, planning/terminal, recoverable error/Fix/Retry and the resulting plan. Launch UUIDs correlate arrivals, preserve concurrent launches and prevent unrelated arrivals from clearing state. Only the originating visible Home chat springs into its plan; other arrivals offer Review. |
| Queue continuity | Planning requested during a reply waits for active and queued sends to finish. Requests live above ChatRoom, survive navigation and fetch the complete final transcript before launch. Cancel restores the instruction. |
| Source continuity | Saved briefs use `Brief · <chat title>`. Session-tree lineage supplies persistent graduation markers and the voice-panel From chat history. Fresh plan voice sessions receive a UTF-8-bounded excerpt with the first user instruction and recent messages. |
| Per-comment model/effort | Picker appears beside Discuss and in open-thread controls; saves are keyed by plan/comment/backend and disabled while streaming. Picks persist independently from fork identity. Claude uses seat overrides; Codex uses its plan/picked model and top-level TOML-encoded effort. Native-provider Claude sidecars retain their restricted tools. |
| Slow default | The real `fork_plan` setting was changed from opus/max to opus/xhigh after verifying Redline was not running; a private backup was made first. |
| Missing-transcript recovery | Boot removes inherited Claude session markers while retaining configuration. Structured CLI errors survive classification. Missing conversations do not retry as transient failures. Discussions seed from the latest plan when the author's transcript is missing, then resume their own new session. |

## Verification

Focused frontend suite: 173 tests across conversation contexts, masks, launch matching/invariants, composer keys, continuation provenance, ChatRoom, comment-thread model selection and app-lifetime queue behavior passed. A subsequent source guard also verifies launch registration precedes terminal delivery, preventing very early arrivals from leaving a stale pending card. The existing Drafter receipt fixture was updated for the required launch UUID.

Backend regression coverage includes environment allow/deny cases, structured missing-conversation errors and reset behavior, no transient retry for dead resumes, fresh/follow-up seeded arguments, model/effort flag placement, database reopen/discard persistence, parent-chat lookup, UTF-8 excerpt limits, voice context priming and absent launch-ID serialization. These passed in the coordinating full Rust run. The coordinating agent owns final full-suite, production build, size and clippy results.

No native app was running during implementation or the seat update. The integrated signed build passed an isolated native startup probe with injected inherited Claude session variables, then was installed and launched; its daemon reports an open window. Live transcript creation, audible voice continuity, real Claude/Codex latency and argv inspection, and the native GUI walkthrough remain unverified. The memory reference for inherited dev-app environment and the project memory document the fix and its behavioral validation boundary.

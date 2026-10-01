> UX update, September 29: the visible island and sidecar-hosting proposal below is superseded by [the front-door and surface contract](frontdoor-surface-contract-2026-09-29.md). Shared routing remains behind distinct GUI surfaces.

**Redline: one agent, every surface — product direction, September 28, 2026**

Implementation status: the [Aurora implementation record](aurora-implementation-2026-09-28.md) identifies the working code, verification, and remaining acceptance boundaries. This document preserves the broader product direction; proposed capabilities here are not automatically claims of shipped functionality.

Redline should let someone move from research to a reviewed decision to verified work without repeatedly explaining themselves, choosing another surface agent, or rescuing an integration. Monochat is the continuous relationship with that work. Documents, browser pages, diffs, memory, and run graphs remain first-class places to read and act.

This design incorporates the supplied composer screenshots, the SuperIsland motion reference, and the requirement to preserve sidecar discussions and action items. The accompanying [interactive concept](monochat-island-prototype-2026-09-28.html) demonstrates the interaction with simulated data. It does not change the running application, install integrations, or call models. The [integration audit](harness-integration-audit-2026-09-28.md) supplies the underlying code findings and Claude/Codex comparison.

**The competitive standard**

These are capabilities described by each project's primary sources, researched September 28. They are not results of running the products or a claim that Redline already outperforms them.

| Product | Relevant advertised strength | What Redline needs to demonstrate |
| --- | --- | --- |
| [Omnigent](https://omnigent.ai/) | A common harness layer, agent composition, stateful policies, sandboxing, and shared live sessions. | Reliable adapters and enforceable execution controls; continuity from a decision in the document to its implementation and review. |
| [DeepSeek Harness](https://deepseek.com/harness/en/) | Replaceable runtime capabilities and an append-only trajectory supporting inspection, resume, and fork. | A stable extension contract, recoverable events, and provenance that a reviewer can navigate without reading a raw trace. |
| [Paperclip](https://github.com/PaperclipAI/paperclip) | Agent teams organized around goals, work, budgets, and governance. | Clear ownership, bounded work, durable decisions, and visible cost per accepted outcome, integrated with actual artifacts. |
| [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) | One coordinator over multiple CLI agents, persistent memory, a visual office, and onboarding that offers to install missing components. | Equally easy setup and one coherent agent relationship; a calm document experience with concrete evidence of progress. |
| [Orca](https://orca.space/) | Persistent agent identities, scoped ownership, structured communication, and multiple harnesses. | Ownership and handoff correctness, plus an accessible way for the user to understand and revise the work. |

“Orca” is ambiguous across several projects. This comparison provisionally uses Orca Agentics at orca.space, whose stated product matches the meta-harness category; no claims about similarly named repositories are inferred.

One coordinator, memory, and a model picker already appear in this market. Redline's strongest proposed distinction is the quality of the whole decision loop: ask in context, explore an anchored discussion, turn it into reviewable feedback, see the resulting revision, accept or reopen it, and carry the accepted decision into execution. Monochat should make that loop feel effortless. This is a product thesis to validate with users, not an assertion of exclusive capabilities.

Start with developers and technical product teams doing consequential, reviewable work. Keep the architecture extensible to more harnesses and execution locations. Ship complete Claude/Codex journeys before advertising a long list of partially working integrations. Remote-node provisioning, broad business automation, and cross-device collaboration can follow once the core journey is reliable.

**One agent; precise discussions**

There is one foreground Redline agent, one entry point, one remembered conversation, and one composer across the app. A surface change changes what the agent can see; it does not choose another persona, create a new chat, or discard the user's draft. The current Home-only Companion is a starting point, not the finished runtime.

Sidecars remain anchored, addressable discussions. Opening a comment focuses its thread in Monochat, highlights its source, and exposes its existing history and actions. The inline sidecar can remain as a reading projection with a “Reply” action that focuses the same composer. It must not launch a second conversational agent or maintain a competing draft. Returning to the main conversation restores its draft and scroll position.

The standalone Discuss pill goes away once all its useful entry paths reach Monochat. Plan text selection, code annotations, draft comments, evidence pins, and action items remain. Their interaction supplies context to the one agent. Voice becomes an input/output mode of that agent. Memory questions use the same conversation and citation rendering. Page, mission, plan, and memory become tools and context sources rather than agents the user must select.

An execution run can still have task workers where its approved workflow calls for them. These are inspectable delegated jobs owned by the foreground agent, not additional surface conversations. Merely navigating or opening Monochat must not spawn workers. Harness selection must describe the real runtime; choosing Codex must never silently execute the conversation on Claude.

**The island interaction**

Working assumption: first deliver the island within Redline, on every surface. A later desktop-wide mode should host the same conversation service and state. The user has been asked about this boundary; the design does not depend on an answer to explore the in-app experience.

| State | Starting dimensions in a roomy window | Behavior |
| --- | --- | --- |
| Resting notch | About 156 × 30 px at bottom center | Small Redline mark and restrained status. The document keeps its width, focus, and scroll position. |
| Glance | About 224 × 42 px | Hover after a short dwell reveals status or “Ask Redline.” No keyboard focus, model call, or transcript expansion. Keyboard focus provides equivalent discoverability. |
| Composer | About 580 × 150 px, growing with the draft | Click or ⌘J grows the same shape upward and focuses typing. Context above; model/harness and location below; attachments, voice, send at the trailing edge. |
| Conversation | About 620 × 420 px; bounded by viewport | Answer appears above the composer. Grow for useful content, then scroll within the conversation. Long replies do not take over the entire document. |
| Focused sidecar | Same island; explicit anchor chip | Show the selected thread and its review actions. Keep the source visible/highlighted. Returning from the thread restores the main conversation. |
| Attention | A stable count/status in the notch | Completed work, an unanswered question, or a failure can be inspected on demand. It does not repeatedly open the conversation. A submitted action blocked by setup opens its recovery modal immediately. |

The images supply the composer hierarchy, not fixed model names or a promise of remote nodes. The model chip opens models valid for the selected harness, with supported effort controls. The location chip defaults to the selected project on this Mac; unavailable remote execution is not presented as working. Keep integration health adjacent to harness selection.

Use a continuous bottom-centered silhouette: shape, width, height, and corner radius evolve together. The main expansion should settle in roughly 350–450 ms with restrained overshoot; content fades in after there is room to read it. Collapse should feel like the content is being drawn back into the notch. Avoid scaling text through the full animation. These are starting tuning values, not measured performance claims.

SuperIsland keeps its hosting content stable while changing the visible window bounds and delays shrinking the hit region until collapse settles. It also suppresses hover dismissal during resizing. Those are useful implementation lessons for preventing clipping and accidental collapse. Its native implementation is a borderless panel; Redline's in-app prototype is an independently authored web interaction. [Window controller](https://github.com/shobhit99/SuperIsland/blob/main/SuperIsland/Window/IslandWindowController.swift), [panel](https://github.com/shobhit99/SuperIsland/blob/main/SuperIsland/Window/IslandWindow.swift)

Do not auto-collapse while typing, composing with an IME, selecting response text, dictating, dragging attachments, or using an open menu. Escape closes the innermost popup first, then returns conversation to composer, then folds the island. An explicit minimize control folds it immediately while saving the draft. Restore focus to the original document target when appropriate. Opening ordinary chat leaves the document interactive and undimmed. Reduced motion uses a short fade with no bounce; SuperIsland also provides reduced-motion behavior. [Appearance reference](https://github.com/shobhit99/SuperIsland/blob/main/docs/APPEARANCE.md)

At narrow widths the island uses the available width with safe gutters; popovers open upward and remain in view. At short heights, conversation scrolls before the input is obscured. Provide adequate hit targets, visible focus, labelled controls, polite activity announcements, and status text as well as color. Idle means no decorative perpetual animation or agent polling to produce simulated activity.

**Preserve the sidecar contract exactly**

The existing implementation does substantially more than display replies. [CommentThread](../src/components/CommentThread.tsx:193) can attach a discussion transcript to the next submission, promote a question into change feedback, reopen a resolved comment with a follow-up, and flag an attachment that became stale after more discussion. Submitted, accepted, and withdrawn comments have different action availability. Draft discard and submitted-thread discard have different semantics.

Those behaviors are migration requirements:

| Existing behavior | Monochat treatment |
| --- | --- |
| Anchored sidecar history and attachments | Retain session/comment identity, authorship, anchor and revision, message IDs, files, and complete history. Focus is a view over that record. |
| Read-only discussion | Ask remains read-only. Surface knowledge does not grant edit authority. |
| Add discussion to the next revision | Keep explicit attachment, question-to-change promotion, and the exact attached transcript snapshot. Further discussion displays “Update attached discussion.” |
| Pending submission | Retain the batch identity and disable incompatible actions until its result is known. Do not silently mutate feedback already in flight. |
| Resolution awaiting a decision | Preserve Accept and Reopen. Today's Action items are resolved comments awaiting those decisions, not an interchangeable generic todo list. [Current action items](../src/App.tsx:9473) |
| Accepted or withdrawn item | Preserve closure and the deliberate Reopen operation. An agent reply cannot implicitly accept its own resolution. |
| Draft discard | Preserve existing draft-comment removal semantics; keep submitted/resolved comment identifiers even when their discussion is discarded. |
| Ask versus Revise | Asking does not mutate the plan. Revising targets a known revision and the selected feedback batch. |

A compact “Needs your decision” count can live in the notch. Selecting an item opens the relevant revision and comment, then focuses that sidecar in Monochat. Full thread reading can expand beside the document when needed, but editing remains through the same agent service and composer ownership. The document's annotations remain useful even with the island closed.

**Context awareness needs a durable backend contract**

Reuse the shared turn lifecycle, event deduplication, review engine, and stored thread identities. The current [conversation mapping](../src/lib/conversationContext.ts:8) unifies some presentation, but still chooses different conversation kinds. [Companion](../src-tauri/src/companion.rs:3) already consumes an active surface and activity journal; its actual spawn is Claude-specific. It also rotates after 12 assistant turns with a short recap. That recap alone cannot preserve a long, cross-surface working relationship.

Introduce a foreground conversation service above the provider adapters. Its turn request needs an immutable envelope: operation ID, conversation ID, destination thread, context references, project/execution location, selected harness/model/effort, intended action, and relevant expected revisions. The backend validates this before accepting the turn. Different surfaces call this same service.

Context follows the surface when the composer is empty. Once a draft has an explicit anchor, or a write-directed target has been captured, navigation must not retarget it. A queued request retains its original document, tab, repository, revision, and destination thread. The UI should say “Replying to §2 · revision 3” even while another page is visible. Returning to the general conversation or changing targets is explicit and preserves per-target drafts.

Build context in layers: the user's request and target; the anchored source and thread; related accepted decisions and unresolved work; relevant recent activity; then retrievable files, pages, and memory. Show an inspectable “Context” list with origins and timestamps. Pin useful evidence; exclude unrelated projects and sensitive material unless the task calls for access. Maximal awareness means being able to retrieve the right evidence, not injecting every transcript on every turn.

Maintain a durable working-state record of goals, constraints, accepted decisions, unresolved questions, and artifact references. Summaries are derived indexes, never replacements for source records. After context rotation, retrieve exact evidence when a claim or action depends on it. Keep older revisions distinguishable from current ones. When an anchor cannot be resolved confidently after editing, show that uncertainty instead of silently attaching to another block.

The root conversation and sidecar lens should reference one canonical message/event, not write independent copies that can disagree. Preserve existing tables behind a migration layer initially; add stable links to the foreground conversation and original scope. Idempotent commands and a durable outbox should connect user intent to accepted dispatch and observed result. Do not claim network delivery provides exactly-once execution; reconcile unknown outcomes before retrying side effects.

Provider changes preserve Redline history and disclose the new runtime. Native Claude and Codex conversation state is not interchangeable: a new provider receives a provenance-rich handoff and linked artifacts, not a fabricated claim to have resumed the other provider's thread. Health and capability checks happen before the handoff. The earlier [native Codex adapter proposal](harness-integration-audit-2026-09-28.md) remains necessary.

**Fast intent routing and memory enrichment**

Add a small decision layer before expensive agent work. TypeSafe describes Jev as a text-input model producing constrained decisions and probabilities, and explicitly notes that calibration does not guarantee an individual answer is correct. It is a candidate for the classifier interface, alongside local rules or another measured classifier; it is not a required dependency. Typed output still needs semantic validation. [Official System One documentation](https://docs.typesafe.ai/concepts/system-one)

The layer should classify the user's actual request together with a compact surface snapshot. Start with finite intents such as `navigate`, `find`, `explain`, `recall`, `discuss_anchor`, `propose_revision`, `run_approved_work`, and `unknown`. Allow compound requests. Identify the target from supplied candidates: selected tab, named document/revision, focused sidecar, chosen project, and known locations. Location is data, not an assumption that every browser message requests browser action.

| User request and context | Dispatch | Visible response |
| --- | --- | --- |
| “Open https://example.com” from a browser discussion | Validate the explicit URL and captured tab; use the existing browser action service without a reasoning round trip. | Show opening state, then observed completion or a retryable error. |
| “Find the pricing page” | Resolve among current, observed links or perform an authorized search. Escalate if the target is ambiguous. | Navigate when the target is grounded; ask a short question only when necessary. |
| “Why does this page recommend that?” | Read selected content and relevant sources through the same agent. | An answer grounded in that page; no navigation merely because the browser is active. |
| “What did we decide about Codex setup?” | Retrieve decision records with project/provider/topic hints and source links. | A concise answer citing the accepted decision and its date/revision. |
| “Change this section to match that decision” in a sidecar | Resolve the anchor and cited decision; prepare the existing revision-feedback action. | Reviewable change feedback attached to the correct comment/revision. |
| “Research three options, then update this plan” | Main agent plans the dependent work; delegate bounded independent research only within the task's authority and budget. | One continuous progress stream with inspectable work and reviewable proposed changes. |

Use deterministic dispatch for explicit, well-scoped operations first. Otherwise ask narrow classification questions together, with a deadline and an abstain route. A classifier outage should fall back to the normal agent, not disable chat. Keep classification and memory prefetch speculative and read-only until routing is accepted. Never race two executors or execute a predicted tool while another model is still deciding whether the request asks for it.

The routing result should carry intent candidates and scores, selected target reference, evidence spans from the user request, capability requirements, estimated work class, and retrieval hints. An independent policy check owns authorization, allowed operations, budget, and expected revision. The classifier cannot approve writes, accept a resolution, broaden a browser target, or choose an unavailable harness. Probability thresholds need calibration on Redline examples; a universal number such as 0.9 is not a correctness guarantee.

For browser interaction, select from controls in a current observed DOM/accessibility snapshot rather than inventing selectors or URLs. Bind the choice to tab identity and snapshot revision, and re-observe after navigation or a stale-target response. Page text and retrieved documents are evidence, not instructions to the router. Preserve the existing operation IDs, page serialization, and observable acknowledgements in [browser_actions.rs](../src-tauri/src/browser_actions.rs:1). A dispatched command is not proof that the desired destination loaded.

For memory, reuse classification features without conflating three records: **requested intent**, **inferred labels**, and **observed outcome**. Index project, provider, source surface, target/anchor, topic, entities, event type, timestamps, and lineage. A user request, an agent suggestion, a submitted change, and a user-accepted decision must remain distinguishable. Derived labels include classifier/version/confidence and can be corrected or rebuilt; the source event is immutable. Capture preferences continue to gate ingestion before enrichment.

Retain ClassMemory's human-curated catalog contract: automatic operational labels and retrieval hints are a separate derived index; taxonomy moves remain proposals. The existing [ClassMemory module](../src-tauri/src/classmem.rs:3) documents this separation between raw lake and reviewed catalog. A fast label must not silently reorganize accepted classes or mark an idea as approved.

On retrieval, use intent and scope as ranking signals, not hard exclusions that can hide the answer after a classification error. Fetch exact linked decisions/threads first when IDs are known; then search indexed text and the catalog, score a bounded candidate set, and expand only when evidence is weak. Invalidate cached retrieval by source/corpus revision, permissions, project scope, and catalog version. Cache source references as well as text. Superseded decisions must remain discoverable without being presented as current.

A recent research preprint, Jev-Mem, explores a related separation: a fast controller for memory organization/retrieval and a reasoning layer for synthesis. It supports investigating this design, but its benchmark results do not predict Redline's speed or accuracy. [Jev-Mem, September 21, 2026](https://arxiv.org/abs/2609.23986)

Ship the router in shadow mode first: record its proposed route while existing behavior runs. Use explicit user corrections and observed failures to curate a held-out evaluation set, with negation, quoted instructions, stale tabs, mixed intents, ambiguous locations, multilingual requests, and cross-project recall. Then enable a narrow allowlist of verified fast paths. Measure end-to-end p50/p95 latency, correct-target rate, unnecessary clarification/delegation, false-action rate, retrieval recall, citation correctness, stale-answer rate, and cost. Compare with no classifier; retain the fast layer only where it improves the complete journey. Cloud classification must be an explicit configured provider choice, consistent with Redline's local-first data settings.

**Preference-aware orchestration across harnesses**

The foreground agent owns the user's goal. A scheduler turns an accepted work plan into dependent tasks and chooses a capable harness for each. Classification supplies routing hints; it does not by itself decide that delegation is useful. Simple actions should remain simple. Dispatch parallel workers only where expected benefit exceeds startup, context-transfer, review, and merge costs.

Resolve preferences in order: the current explicit instruction, an explicit project preference, the user's saved defaults, then a measured recommendation. Separate hard constraints (allowed providers, local-only data, spending ceilings, permission boundaries) from soft preferences (speed, depth, preferred harness, minimal interruptions). Inferred preferences should be inspectable, reversible suggestions and should not override explicit choices. A one-time Codex choice is not automatically a permanent policy.

An example workflow is sequential overall but concurrent where useful: capture the goal and current document; investigate independent requirements on capable Claude/Codex workers; reconcile evidence through the foreground agent; revise the anchored plan; implement approved work on isolated task scopes; run independent checks; present the resulting diff and unresolved decisions. The selected chat harness can remain Codex throughout. Worker provenance remains visible without asking the user to manage several conversations.

Each task needs an input artifact/revision, expected output, capability requirements, read/write scope, dependencies, budget, cancellation behavior, and completion evidence. Serialize overlapping writes unless genuine isolation and a tested merge path exist. Redline's current runner uses a shared working tree and Claude task spawning; adding Codex options to a picker cannot supply isolation or scheduling parity. Dependent tasks consume acknowledged outputs, not partial text that merely sounds complete.

Minimize interaction by retaining standing authorization, reusing captured project/location preferences, and recovering transient failures with bounded retries. An explicitly permitted provider fallback can run automatically with a visible receipt; a fallback that changes data locality, cost limits, or user-specified harness cannot be inferred from a classifier score. Preserve active sessions through integration updates. Distinguish a provider outage, a depleted account, an incompatible binary, a failed check, and an ambiguous user goal so each gets the appropriate recovery.

Expose a compact work tray from the island: what is running, on which harness, what depends on it, what needs the user, and what has been verified. Show estimated cost only when an estimate is available, distinguish it from measured usage, and avoid invented progress percentages. “Stop” should state whether it pauses the goal or interrupts a particular task; stopping future dispatch must not erase already produced artifacts.

The memory layer records why a harness was selected, observed quality/latency/cost, user corrections, and accepted results. Use those outcomes to improve recommendations with task-class-aware comparisons, rather than favoring whichever harness happened to run the easiest jobs. Do not turn inferred task labels into permanent assumptions about the user. Track friction as unnecessary questions, repeated instructions, context reconstruction, rescue actions, and time spent managing agents; fewer clicks alone can conceal worse outcomes.

**Integration and rendering risks to resolve first**

The island must consume the same operation-specific readiness snapshot as the launch gate. Missing Codex setup opens a focused install/repair modal on detection for the selected provider; a submitted request stays pending through setup and continues once after verification. Cancellation preserves it. Background activity remains a notch indication; a blocking failure on the user's current action deserves immediate recovery. This addresses the original toast-only failure without making ordinary notifications intrusive.

Redline's browser is a native webview that can paint above DOM overlays. Existing dock code deliberately reserves space to avoid that problem, and menu overlays can hide the webview. A fixed CSS island with a high z-index is therefore insufficient. Prototype the native composition separately: a dedicated child overlay webview/panel with a bounded hit region is a candidate; reserving space is a fallback that needs UX review. Do not ship a “floating” chat that blanks the page whenever it opens. Verify pointer routing, typing focus, clipping, resizing, dialogs, fullscreen, and display changes in the packaged app. See [overlay coordination](../src/App.tsx:686) and [current dock](../src/App.tsx:8734).

Keep conversation state outside its visual mount. Collapsing, changing surfaces, or opening a sidecar must not abort a turn, re-send a seed, lose an attachment, or create competing subscriptions. The existing portal host and `useAgentTurn` recovery logic are useful foundations; audit their ownership before replacing the dock.

**Delivery sequence and proof**

| Milestone | Concrete result | Release evidence |
| --- | --- | --- |
| 1. Trustworthy entry | Shared readiness, Codex setup modal, bounded probes, verified repair, persistent pending intent. | Fresh/stale/partial installation and upgrade cases pass; no toast is the sole recovery affordance. |
| 2. One agent service | Provider-neutral foreground conversation with immutable targets, durable state, and linked legacy threads. | Navigation during a queued turn cannot change its target; no duplicate messages; reload recovers pending work. |
| 3. Island and sidecars | One bottom island on every surface, focused anchored threads, existing review actions, shared voice and memory entry. | Draft/selection/history survive focus changes; all sidecar attach/refresh/accept/reopen/discard contracts pass; native browser remains usable. Remove the old Discuss pill and redundant surface composers here. |
| 4. Codex as a complete peer | Native managed plan/discussion/events/approval/restore and suitable execution adapter support. | Complete Claude and Codex journeys pass using supported binaries, including interruption and exact-revision approval. |
| 5. Visible quality advantage | Revision-linked visuals, evidence navigation, independent checks, and bounded optional alternatives. | Users find and resolve consequential issues faster, with lower rescue effort and acceptable measured cost. |

Milestones are dependency order, not delivery-date estimates. The island can be explored now, but its final backend must not be a cosmetic wrapper over the old collection of surface agents.

Use a repeatable competitor evaluation: fix the repository/task, model where possible, budget, initial account/install state, product version, and allowed interventions. Include first install, research-to-plan, anchored critique-to-revision, approve-to-build, interruption/recovery, harness change, and visual defect correction. Run multiple trials and record failures as well as successes. Beta or unavailable products remain unmeasured.

Track time to first usable result; setup completion; human rescue actions; lost drafts/context; unintended target changes; sidecar-to-revision correctness; resume success; verified task completion; cost and elapsed time per accepted result. Hard release requirements include no lost drafts in the tested transitions, no duplicate dispatch from repair/reconnect, and no acceptance applied to the wrong revision. Set latency and success-rate targets after collecting a baseline. This is how Redline earns a market-leadership claim.

**Prototype scope**

The HTML concept is an original, dependency-free interaction sketch: notch/peek/composer/conversation, surface changes, anchored discussion focus, sample action-item decisions, model/harness selection, and simulated setup recovery. It uses fixed example replies and makes no network requests. It is not a substitute for the backend migration, live model testing, or native macOS composition testing.

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The browser chat's intended behavior, as a numbered catalogue. Each rule
// names where the decision was made, so a future change can tell a law from
// an accident. invariants.test.ts fails when a rule has no test naming its id,
// so adding a rule means pinning it.
//
// Sources are memory notes (memory/<name>.md), dated plans, or the code that
// carries a decision in its comments. "REJECTED" rules record reversals that
// must not be re-proposed.

export interface Invariant {
  id: string;
  area: "scope" | "turn" | "agent" | "composer" | "persistence" | "presentation" | "rejected";
  rule: string;
  source: string;
}

export const INVARIANTS: readonly Invariant[] = [
  // --- conversation scope ---------------------------------------------------
  { id: "BC-1", area: "scope", rule: "A tab's own chat is keyed by its durable browseId; tab NUMBERS are positional display/conversation handles only, and the agent names tabs 'tab N — title', never an internal id.", source: "project_redline_tab_numbers, project_redline_browser_newwindow" },
  { id: "BC-2", area: "scope", rule: "Linked mode (global, persisted, default off) decides where a new tab or tab switch lands: off → that tab's own chat; on → the workspace's one shared chat.", source: "plans-20261009/browser-linked.md" },
  { id: "BC-3", area: "scope", rule: "A Tab chat / Shared chat flip is momentary: it shows the other kind on the visible tab until the anchored conversation changes, is never persisted, and the UI names the kind of chat only when it is the exception.", source: "plans-20261009/browser-linked.md" },
  { id: "BC-4", area: "scope", rule: "One shared chat per workspace (regular, each mission, each mosaic). Starting a mission from regular browsing carries the tabs AND the shared chat into the mission; regular starts fresh.", source: "project_redline_browse_missions (v2), BrowserPane.startNewMission" },
  { id: "BC-5", area: "scope", rule: "An agent-opened tab comes forward while the conversation stays anchored to its origin; a manual tab click or an agent /focus is a full switch that re-couples page and conversation; closing the anchored tab re-anchors to the page on screen.", source: "project_redline_browse_agent, project_redline_tab_numbers, BrowserPane.selectTab/openTab" },
  { id: "BC-6", area: "scope", rule: "Plan Search always opens a FRESH tab with its OWN chat (no URL de-dup), in either mode; View result returns to that thread.", source: "plans-20261009/plan-search.md" },
  { id: "BC-7", area: "scope", rule: "A conversation link returns to the exact thread it names, in either mode; a closed tab's thread says so instead of guessing.", source: "plans-20261009/browser-linked.md step 5" },
  { id: "BC-8", area: "scope", rule: "A workspace swap drops any flip and lands where the mode says; tabs reattach to their threads by browseId.", source: "project_redline_browse_missions (v2), project_redline_mosaics" },
  { id: "BC-9", area: "scope", rule: "A shared chat exists before anything renders it; a tab's own thread is never shown labelled as shared.", source: "derived from BC-2 + conversationContext's 'context follows what is on screen'" },
  { id: "BC-10", area: "scope", rule: "The dock holds the browser's panels (page chat, Task list, Mission) by portal; context follows what is on screen and a pin only breaks ties; the dock's page descriptor is the RESOLVED conversation.", source: "project_redline_conversation_dock" },
  // --- what rides a turn ----------------------------------------------------
  { id: "BC-11", area: "turn", rule: "A turn embeds a snapshot of its target until a session on this provider has answered, and again whenever the target page changed; otherwise the agent re-reads /snapshot itself. A suspended target grounds from the cache.", source: "project_redline_browse_agent (hybrid), project_redline_browser_tab_suspension, plans-20261009/provider-picker.md" },
  { id: "BC-12", area: "turn", rule: "Each turn captures its target label and scope (pinned page | following tabs) at SEND time; a queued turn keeps what it was typed against, and a tab switch mid-turn never retargets it.", source: "browse.rs QueuedBrowseSend + start_browse_turn tail" },
  { id: "BC-13", area: "turn", rule: "Only a mission workspace is captured as a mission; regular and mosaics are 'no mission'. The captured mission's goal rides the first turn and later turns read that mission's routes, never the globally active one.", source: "project_redline_mission_awareness, browse.rs captured_browse_mission" },
  { id: "BC-14", area: "turn", rule: "Highlight actions: Ask seeds the composer and waits; Define/Explain/Research send at once (after the thread restores); ＋ List writes to the Task list with a note; Copy never leaves the page.", source: "project_redline_highlight_to_chat, project_redline_tasklist_pages_pointers" },
  { id: "BC-15", area: "turn", rule: "An inspected element is attached to the composer and opens the page chat on that tab.", source: "BrowserPane.lifecycle.test 'an inspector click immediately opens chat with the element attached'" },
  { id: "BC-16", area: "turn", rule: "The Task list is not a conversation: one per workspace, items filed under the page they were written on with a location pointer, no ledger writes; 💬 on an item seeds the page chat; one renderer feeds both handoffs.", source: "project_redline_browselist_batch, project_redline_tasklist_pages_pointers, docs/browser-simplification-2026-09-25" },
  { id: "BC-17", area: "turn", rule: "Project context: host + project index on a session's first turn; project cards only for projects the user or mission NAMES (never page text), once per session per provider; code is read-only.", source: "project_redline_browse_code_access, docs/plans-20261006-progress 'Browser project context'" },
  { id: "BC-18", area: "turn", rule: "Each provider resumes only its own session; the side without one is handed the turns it missed (continuity block) plus a snapshot.", source: "plans-20261009/provider-picker.md Phase 2" },
  // --- what the agent may do ------------------------------------------------
  { id: "BC-19", area: "agent", rule: "The agent reads any tab with ?tab=<n> and mutates only through POST /v1/browser/action on the CAPTURED label (operationId, expectedRevision, typed operation), checking the observed result and never replaying an uncertain side effect. The older /navigate, /click and /query routes (and the /active read) still answer but are never taught.", source: "browse.rs per-turn tail (a382cfd), browser_actions.rs, the 10/10 structure-layer decision (keep the old routes, stop teaching them)" },
  { id: "BC-20", area: "agent", rule: "WebSearch/WebFetch are granted and used instead of driving the tab to a search engine; /open for a new page, a navigate action only when the user wants THIS tab elsewhere; other tabs are checked in place.", source: "project_redline_browse_skill, project_redline_tab_numbers" },
  { id: "BC-21", area: "agent", rule: "The only disk write is /v1/browser/download; no file edits, no writing git, no ExitPlanMode.", source: "project_redline_browse_skill, project_redline_browse_code_access" },
  { id: "BC-22", area: "agent", rule: "Cross-tab: /tabs is the map and /thread?tab= reads what was discussed about a tab; the Companion's consult is the only caller of a tab agent's digest (the linked discussion surface is gone).", source: "project_redline_linked_discussion (REMOVED a382cfd), project_redline_companion_program" },
  { id: "BC-23", area: "agent", rule: "Inside a mission the page agent is oriented to the mission's goal and never claims it lacks access to it.", source: "project_redline_mission_awareness" },
  { id: "BC-24", area: "agent", rule: "Curation is the user's: the agent never pins to a mission, files a Task-list item or launches a plan. Reply actions (Copy, ＋ Add to task list, Add to mission inside a mission, Continue as…) are user gestures.", source: "project_redline_browse_missions, project_redline_browselist_batch, project_redline_offered_items (offers are plan-voice only)" },
  // --- composer, provider, streaming ----------------------------------------
  { id: "BC-25", area: "composer", rule: "Provider/model/effort are picked per conversation in the chat, stored per thread, never disabled, and apply to the NEXT message; a new chat inherits the last pick and stores it on first send; Codex only when the probe says it can run.", source: "plans-20261009/provider-picker.md, BrowseHarnessChip tests" },
  { id: "BC-26", area: "composer", rule: "A reply is signed by the provider that wrote it; the streaming reply by the provider it was sent to.", source: "BrowserChat.header.test" },
  { id: "BC-27", area: "composer", rule: "The composer is never disabled: one round button is the mic on an empty box and while it listens, send with something to send, queue while a reply runs, and stop on an empty box while it runs; Enter sends, mid-stream Enter queues (cap 5), Shift+Enter is a newline, Stop cancels only the current reply and the queue then drains, × on a queued row restores its text, an unsent row offers resend, and drafts persist per conversation.", source: "project_redline_streaming_continuity (P3), agent-IDE panel research §12.1.4, feedback_voice_first_class" },
  { id: "BC-28", area: "composer", rule: "One turn lifecycle (useAgentTurn + turn.rs): seq-guarded deltas, remount restores the partial reply, a send whose capture outlived its panel is dropped.", source: "project_redline_streaming_continuity (P1/P2)" },
  { id: "BC-29", area: "composer", rule: "Browse has no steer route yet; queueing is the only mid-turn input.", source: "useAgentTurn (companion_steer only)" },
  // --- persistence, suspension ----------------------------------------------
  { id: "BC-30", area: "persistence", rule: "Threads, picks and per-provider session ids persist in SQLite; Clear history drops the thread and its pick; a context-overflow reset keeps the pick.", source: "project_redline_browse_agent, plans-20261009/provider-picker.md" },
  { id: "BC-31", area: "persistence", rule: "Background tabs suspend and stay discussable from the snapshot cache; actions wake a tab hidden; a tab that a running turn targets stays live.", source: "project_redline_browser_tab_suspension" },
  { id: "BC-32", area: "persistence", rule: "Panel visibility is the browser's; each tab remembers its pill; the memory prunes idle tabs by recency and never a live one; the dock's open bit is never persisted.", source: "project_redline_browselist_batch #2, project_redline_conversation_dock" },
  // --- presentation, focus (10/10 direction) --------------------------------
  { id: "BC-33", area: "presentation", rule: "Nothing takes the caret on mount, tab switch, background seed or agent action; only a gesture whose point is typing next (Ask, an inspected element, 💬 on an item) places it.", source: "feedback_front_door_returns" },
  { id: "BC-34", area: "presentation", rule: "A turn in flight is the reply, not boxes around it: one live line at its end names the step running now; a finished step becomes a quiet verb + object row under the text, kept with the message so a reload draws the same rows; a run of reads and searches folds into 'Explored …', and an action, a consult or an artifact never folds; a step never moves text already written; no meters in the stream.", source: "feedback_front_door_returns ('no unnecessary streaming boxes'), DESIGN-20261010 decision 7, agent-IDE panel research §12.1.2–3 and §12.2" },
  { id: "BC-35", area: "presentation", rule: "Replies read as prose (no bubbles), code blocks carry copy, and links open as Redline tabs.", source: "project_redline_browse_discussion_polish, feedback_front_door_returns (agent-IDE chat panel model)" },
  { id: "BC-36", area: "presentation", rule: "No new header buttons for chat features; linked mode is the 🔗 / ⛓️‍💥 icon in the chat header.", source: "feedback_no_header_button_sprawl, plans-20261009/browser-linked.md" },
  { id: "BC-38", area: "presentation", rule: "The thread follows new output only while the reader is within 48 px of the bottom; scrolling up stops it, and ↓, End or a send resumes it. A reply the reader was following parks at its start once it is taller than the view, so a long answer is read from the top.", source: "agent-IDE panel research §12.1.6 (the 'read long replies from the top' request it documents)" },
  { id: "BC-39", area: "presentation", rule: "Live state rides a rail above the composer, outside the scrolling thread: the queue, the Task list's count, the mission's goal and the ↓ jump. Its trays open upward over the thread without changing the thread's height, and Esc closes them.", source: "DESIGN-20261010 decision 6, agent-IDE panel research §12.1.5 and §12.3" },
  { id: "BC-40", area: "turn", rule: "Context attached in the composer (a quoted highlight, a picked element, a tab screenshot, an image) is a chip, not raw text; it rides the message as text the agent can read, and the user's card shows it again as a chip after the send and after a reload. Reserved boxes keep a screenshot from moving the thread when it paints.", source: "agent-IDE panel research §12.2 rule 6 and §12.3 (highlight-to-chat)" },
  { id: "BC-41", area: "presentation", rule: "While the agent acts on a page its tab shows a dot until the turn ends, and the live line names the action and its tab; an action the user interrupts by touching the page reads 'Stopped — you took over the page'.", source: "agent-IDE panel research §12.2 (live status for page actions) and §12.3 (per-tab chat)" },
  // --- rejected / reversed --------------------------------------------------
  { id: "BC-R1", area: "rejected", rule: "Shared-by-default with a persisted per-tab opt-out list (ownChatTabs) — reversed 10/09.", source: "plans-20261009/browser-linked.md" },
  { id: "BC-R2", area: "rejected", rule: "Linked discussion as its own surface/backend (linked.rs, LinkedChat, linked skill) — removed 09/26; linked is a MODE of the page chat.", source: "a382cfd, skill.rs RETIRED_SKILLS" },
  { id: "BC-R3", area: "rejected", rule: "Tandem agent mode and the rl-sources thumbs strip — retired from the prompt.", source: "browse.rs first_turn tests" },
  { id: "BC-R4", area: "rejected", rule: "The pane's own chat split, DiscussionSwitcher and DockEdgeTab rail — deleted; the dock is the one column, and there is no floating discuss pill on the browser.", source: "project_redline_conversation_dock" },
  { id: "BC-R5", area: "rejected", rule: "DOM popovers over the native webview without hiding it, and iframes instead of child webviews.", source: "project_redline_embedded_browser" },
  { id: "BC-R6", area: "rejected", rule: "The status bar's Plan a build pill and its hover composer (on the browser it launched a Plan only) — removed 10/28; the browser's conversation is the page chat, and the door is ⌘T, ⇧⏎, the palette and the sidebar's New tab.", source: "STATE-20261027-workbench D27" },
];

export const invariant = (id: string) => INVARIANTS.find((i) => i.id === id);

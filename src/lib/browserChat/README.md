# Browser chat: the structure layer

The page chat beside Redline's embedded browser has more rules than any one
component can hold: which thread a tab lands in, what a turn carries, what the
agent may do, what the composer allows, what a reply offers. Until 10/10 those
rules lived in BrowserPane effects, BrowserChat closures, the browse.rs prompt
and the browse skill, and they drifted apart. This directory is the one place
they are written down and executed.

## What lives here

| File | Owns |
|---|---|
| `scope.ts` | `ChatWorld` (tabs, the tab on screen vs the anchored tab, linked mode, the momentary flip, one shared thread per workspace), every gesture as a `ChatEvent`, `reduceChatWorld` (normalizes after every event), `resolveConversation`, `contextLine`, `dockDescriptor`. **Nothing else derives a thread id.** |
| `turn.ts` | `turnEnvelope` (exactly `browse_send`'s arguments), `capturedWorkspace`, `needsSnapshot`, `seedPolicy` (highlight, element, Task-list item, plan Search), `composerModel` (the one round button: mic, send, queue, stop), `replyActions`. |
| `transcript.ts` | How a turn is drawn: `workRows` (a reply's steps as verb + object rows, reads folded, a page action's outcome in place of its call), `liveSteps` and `liveStepLabel` (the one live line), `composeTurn` and `userTurnParts` (the chips a message carries, both ways), `follows` and `parkAt` (when the thread follows). |
| `chrome.ts` | The pill's hover composer on the browser (Plan and Run), the dock's three browser panels, the agent's reach per provider. |
| `contract.json` | Values both languages must agree on: send parameters, scope phrases, routes, action kinds, the queue and project caps, activity phrases, what the skill must and must not teach. |
| `invariants.ts` | The numbered rules (BC-1 to BC-37, and BC-R1 to BC-R5 for rejected designs), each with the memory note, plan or code it was decided in. |

The Rust half is `mod contract` at the bottom of `src-tauri/src/browse.rs`. It
reads `contract.json` and `skills/browse/SKILL.md` with `include_str!` from
`#[cfg(test)]` only, so none of it reaches the release binary.

## Rules for changing behavior

1. Find the rule in `invariants.ts`. If the change contradicts it, the user's
   decision recorded in its `source` wins until the user says otherwise.
2. Change the data or the pure function here first, then the component, the
   prompt or the skill.
3. A new rule gets an id and a test whose title starts with that id.
   `invariants.test.ts` fails otherwise, and also when anything in this
   directory or the code it governs cites an id the catalogue doesn't have.
4. `wiring.test.ts` reads the Rust, the skill and the components. An
   `it.fails` there is a known violation: fix the code, watch the test go
   red, and turn it into `it` in the same change.
5. A value in `contract.json` changes on both sides at once. The TypeScript
   tests and `browse.rs`'s `mod contract` say what else must move.

## For agents working in this area

- The chat shows `resolveConversation(world).browseId`. Do not compute a
  thread id from `activeId`, `discussionId` or `linkedByWorkspace`.
- BrowserPane holds the world through `hooks/useChatWorld`: its own tabs,
  the tab on screen and the workspace, plus a slice only the reducer
  writes. A handler that moves the conversation dispatches an event; it
  never sets the anchor, the flip or a shared thread itself. Each
  workspace's shared thread persists until its workspace is gone: once the
  mission and mosaic lists load, the pane dispatches `workspaces-listed` and
  the reducer forgets the rest.
- A turn's target page, scope and workspace are captured when the user sends.
  The backend never reads the globally active tab or mission for a turn that
  carries a target. Both of the turn's rows keep the targeted tab
  (`browse_messages.target_browse_id`, `targetBrowseId`): a mission pin of a
  reply records that page, however long ago it was written, and
  `/v1/browser/thread?tab=` returns the shared-chat turns about a tab beside
  its own thread.
- The agent changes a page only through `POST /v1/browser/action` on the
  captured label. The older `/navigate`, `/click` and `/query` routes, and
  the `/active` read that `/tabs` replaced, still answer, but the prompt and
  the skill no longer teach them (`legacyRoutes`). Every other route the
  agent may call is taught by one of the two.
- A mission's routes are the captured ones, `/v1/missions/{id}`; a Mosaic,
  like regular browsing, has no mission.
- The agent never curates: no pins, Task-list items or launches on its own.
- A reply's steps are the turn's tool activity, kept with the row's meter.
  What a page action did is written onto the turn by the backend
  (`browser_actions::outcome_step` → `BrowseState::note_action`), in the
  words `contract.json`'s `actionOutcomes` gives, so the row reads the same
  after a relaunch. Rows go under the text: a step never moves text already
  written. Every accepted action is answered, even when its request is
  dropped mid-way, and its acknowledgement names the turns running against
  the page: a tab's dot clears when those turns have ended, never when any
  turn does.
- Context in the composer is a chip that rides the message as text; read a
  message back into its chips with `userTurnParts`, never by matching its
  body in a component.
- Never take the caret, except for a gesture whose point is typing next.
- Retired: the separate linked discussion, tandem mode and its sources strip,
  the pane's own chat split, the edge rail. Do not bring them back.

## Open

- **Which thread a mission pin came from.** A pin records the page its reply
  was about, under that page's tab, which is what the jump to a finding and
  the page capture read. The thread is not recorded: a finding has no column
  for it, so a pin from a shared chat jumps back to its page, not to that
  chat. Replies from before the target was kept are filed under the tab on
  screen.

- **Which tab a shared chat's message was about, on screen.** Each message
  keeps it now, but the user's card shows only the context the message
  carried, not the tab its turn targeted.

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
| `turn.ts` | `turnEnvelope` (exactly `browse_send`'s arguments), `capturedWorkspace`, `needsSnapshot`, `seedPolicy` (highlight, element, Task-list item, plan Search), `composerModel`, `contextPills`, `replyActions`, `streamParts`. |
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
- A turn's target page, scope and workspace are captured when the user sends.
  The backend never reads the globally active tab or mission for a turn that
  carries a target.
- The agent changes a page only through `POST /v1/browser/action` on the
  captured label. The older `/navigate`, `/click` and `/query` routes, and
  the `/active` read that `/tabs` replaced, still answer, but the prompt and
  the skill no longer teach them (`legacyRoutes`). Every other route the
  agent may call is taught by one of the two.
- A mission's routes are the captured ones, `/v1/missions/{id}`; a Mosaic,
  like regular browsing, has no mission.
- The agent never curates: no pins, Task-list items or launches on its own.
- Never take the caret, except for a gesture whose point is typing next.
- Retired: the separate linked discussion, tandem mode and its sources strip,
  the pane's own chat split, the edge rail. Do not bring them back.

## Open

- **Shared-chat check-ins.** `/v1/browser/thread?tab=` returns the tab's own
  thread. In linked mode the discussion about that tab is in the shared chat,
  so the check-in reads an empty thread. The fix needs the target tab stored
  on each browse message, which is a schema decision (`it.todo` in
  `wiring.test.ts`).
- **The sources strip's commands.** `set_source_feedback` and
  `get_source_feedback` have no caller since tandem mode retired. They span
  `lib.rs`, `db.rs` and `state.rs`, so they go in one deletion of their own.

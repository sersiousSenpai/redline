# Redline control-plane API — v1

The local daemon on `127.0.0.1:7676` (loopback only) is Redline's extension API. This table is generated from `ROUTE_TABLE` in `src-tauri/src/auth.rs` (Redline's own routes) followed by `polis_server::ROUTES` (the Polis Memory routes the daemon merges in — `crates/polis-server/src/lib.rs` of https://github.com/sersiousSenpai/polis-memory, at the rev `src-tauri/Cargo.toml` pins) — the same tables the auth middleware enforces on every request — via `UPDATE_GOLDEN=1 cargo test api_doc`. Do not edit by hand.

## Auth classes

- **open** — no credential (read-only surface; may tokenize in a later pass).
- **hook contract** — no credential *by design*: called by the user's own claude sessions anywhere on the machine through the globally installed hooks/skills, which cannot carry a per-boot secret.
- **token: `<scope>`** — requires `Authorization: Bearer <token>`, where the token is either the per-boot master token (env `REDLINE_DAEMON_TOKEN` in every Redline-spawned process) or an extension token granted that scope (see `~/.redline/extensions/`, `src-tauri/src/extension.rs`).
  Callers must not expand the variable through a shell (agent bash sandboxes reject commands containing expansion). Have curl import it instead, keeping the URL first so command-prefix permission rules still match:

  ```
  curl -s http://127.0.0.1:7676/v1/… \
    --variable %REDLINE_DAEMON_TOKEN= \
    --expand-header "Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}" \
    -X POST -H 'Content-Type: application/json' -d '{…}'
  ```

  Both flags require **curl >= 8.3**. The trailing `=` is an empty default: without it curl aborts with `variable expansion failure`; with it an unset token yields a clean 401. macOS ships curl 8.4 on 14+, but 7.x on 11–13.

- **token: master only** — requires the per-boot master token itself; extension tokens never qualify, whatever their scopes. Reserved for control-plane verbs (instance retirement). The token is also persisted to `<app_data_dir>/daemon.token` (0600) so a booting sibling's preflight — same user, no inherited env — can authenticate against a headless incumbent.

Unregistered routes fail closed: a route added to the router without a `ROUTE_TABLE` entry answers 401.

## Routes

| Method | Path | Auth | Purpose | Request | Response |
|---|---|---|---|---|---|
| GET | `/viewer` | open | Redirect to /viewer/ so relative asset refs resolve | — | 308 → /viewer/ |
| GET | `/viewer/` | open | Async-share viewer page (sender's local preview) | — | text/html viewer bundle index |
| GET | `/viewer/*path` | open | Async-share viewer static assets (legacy standalone bundle) | path of the bundled asset | asset bytes with content type |
| GET | `/assets/*path` | open | Shared build chunks for the async-share viewer page (folded into the app build) | path of the built asset under dist/assets | asset bytes with content type |
| POST | `/v1/plan` | hook contract | Plan-hold ingest: the ExitPlanMode hook POSTs the plan and blocks until the review resolves | JSON hook payload {session_id, plan markdown, cwd, ...} | held; resolves to the review verdict (approve/deny reason) |
| POST | `/v1/codex/stop` | hook contract | Codex Plan-mode Stop hook: extracts the proposed plan and holds until review resolves | JSON Codex Stop payload {session_id, turn_id, permission_mode, last_assistant_message, ...} | {} to finish the turn, or {decision:"block", reason} to request revision |
| GET | `/v1/sessions/:session_id/plan` | open | Latest plan revision with block structure (agent-in-doc read) | session id in path | JSON {version, blocks:[{id, markdown}, ...]} |
| POST | `/v1/sessions/:session_id/suggestions` | token: `plan.suggest` | Post a tracked edit suggestion against a plan block | JSON {block_id, op, markdown, ...} | JSON accepted suggestion (or staleness error) |
| POST | `/v1/sessions/:session_id/comments` | token: `plan.comment` | Capture a [feedback] comment (voice agent and read-only agents) that rides the next Revise | JSON {body, block_id?, ...} | JSON created comment |
| POST | `/v1/sessions/:session_id/comment-offers` | token: `plan.offer` | Stage an OFFERED plan item — a `＋ Add as item` chip in the discussion panel; nothing is written until the user taps it | JSON {blockId, body, label?, agentId} | JSON {id, status:"pending"} — the offer, not a comment |
| GET | `/v1/sessions/:session_id/feedback` | hook contract | Out-of-band delivery of the full review payload after a calm one-line deny | session id in path | the pending feedback body (plain text payload) |
| GET | `/v1/browser/active` | open | The tab the user is looking at (id, ordinal, url, title) | — | JSON active-tab summary |
| GET | `/v1/browser/tabs` | open | All open tabs with ordinals | — | JSON tab list |
| GET | `/v1/browser/thread` | open | A tab's page-discussion thread | ?tab= ordinal or id | JSON message list |
| GET | `/v1/browser/snapshot` | open | Text snapshot of a tab's DOM | ?tab= ordinal or id | JSON {url, title, text} |
| POST | `/v1/browser/query` | token: `browser.drive` | Evaluate a DOM-extraction program on a live tab (wakes suspended tabs) | JSON {tab?, query program} | JSON extraction result |
| POST | `/v1/browser/navigate` | token: `browser.drive` | Navigate a tab | JSON {tab?, url} | JSON navigation result |
| POST | `/v1/browser/click` | token: `browser.drive` | Click an element on a live tab | JSON {tab?, selector/target} | JSON click result |
| POST | `/v1/browser/open` | token: `browser.drive` | Open a new tab | JSON {url} | JSON new-tab summary |
| POST | `/v1/browser/focus` | token: `browser.drive` | Focus a tab | JSON {tab} | JSON focus result |
| POST | `/v1/browser/download` | token: `browser.drive` | Save the viewed page or a linked file to disk (the agent's only file-write path) | JSON {tab?, url?, destination} | JSON saved-file path |
| GET | `/v1/mission/active` | open | The active research mission's goal and enrollment | — | JSON mission summary (or none) |
| GET | `/v1/mission/findings` | open | The user's pinned findings for the active mission | — | JSON pin list |
| POST | `/v1/linked/consult` | token: `consult` | Delegate a heavy tab to its own page-discussion agent for a digest (map-reduce) | JSON {tab, question} | JSON digest text |
| POST | `/v1/global/consult` | token: `consult` | Companion fan-out: consult any surface's agent for a digest | JSON {surface/agent, question} | JSON digest text |
| GET | `/v1/global/agents` | open | The agent map: which per-surface agents exist right now | — | JSON agent list |
| GET | `/v1/code/projects` | open | The user's known project folders (the browse agent's code map) | — | JSON project path list |
| GET | `/v1/code/git` | open | Whitelisted read-only git ops (status/branch/log/diff/show) in a known project | ?repo= known project, ?op= whitelisted op | JSON git output |
| GET | `/v1/context/overview` | open | Librarian friction digest: ground-truth counts and staleness | — | JSON overview |
| GET | `/v1/context/codehealth` | open | Shipwright code digest: git state, recorded corrections, static repo health, runtime failures, unfinished work | ?repo=<absolute path> | JSON code digest |
| GET | `/v1/context/sessions/:id/history` | open | One plan session's full history | session id in path | JSON history |
| GET | `/v1/surface/active` | open | Where the user is right now (mirrored ActiveSurface cell) | — | JSON surface id |
| GET | `/v1/journal/recent` | open | Context-journal delta (Companion passive awareness) | ?since=... | JSON journal entries |
| GET | `/v1/drafter/:draft_id/doc` | open | The live draft's markdown mirror | draft id in path | JSON {blocks/markdown} |
| POST | `/v1/drafter/:draft_id/suggestions` | token: `drafter.suggest` | Write a tracked suggestion into the draft (append/replace_block/insert_after/delete_block) | JSON suggestion op | JSON accepted suggestion (or staleness error) |
| GET | `/v1/reviews/start` | hook contract | Code-review hold: captures the diff, opens the review pane, HOLDS until the reviewer submits | ?repo=&base=... from the /redline-code-review skill; defer=1 parks the review for the morning (queued overnight runs) | held; resolves to structured line-anchored feedback (deferred: returns immediately) |
| GET | `/v1/reviews/annotations` | open | List external annotations on a live review | ?repo= known project | JSON annotation list |
| POST | `/v1/reviews/annotations` | token: `review.annotate` | Post a finding into a live review (external local tools) | JSON schema-only body with required source tag | JSON created annotation |
| DELETE | `/v1/reviews/annotations` | token: `review.annotate` | Clear a source's annotations from a live review | ?repo=&source=... | JSON cleared count |
| POST | `/v1/orchestration/report` | token: `orchestration.report` | File an orchestrated run's structured exit report (claims paired against observed ground truth in the RunReport GUI) | JSON {planSessionId, scriptPath, workflowRan, summary, subtasks:[{title, planSection, verified, skipped, notes}]} | JSON {ok} |
| GET | `/v1/work/ready` | open | The work graph's claimable frontier, urgent-first: open items whose defer time has passed, with no deferred ancestor up the parent chain and no unclosed blocker | ?project=&limit=... | JSON {items:[work item, ...]} |
| GET | `/v1/work/:id` | open | One work item plus every typed edge touching it | item id in path | JSON {item, edges:[{fromId, toId, type, ...}]} |
| POST | `/v1/work` | token: `work.file` | File a new work item (task / bug / question / message); `parent` mints a child id and records the parent-child edge | JSON {title, body?, kind?, priority?, status?, parent?, originKind?, originId?, projectPath?, pinned?, deferUntil?, author?} | JSON {item} with the minted hierarchical id |
| POST | `/v1/work/:id/claim` | token: `work.claim` | Claim an open work item: sets the assignee and a lease; 409 when it is not open | JSON {assignee, leaseSeconds?} | JSON {item} as claimed |
| POST | `/v1/work/:id/close` | token: `work.claim` | Close a work item with a recorded reason; 409 when already closed | JSON {reason?, author?} | JSON {item} as closed |
| GET | `/v1/extensions` | open | Installed extensions with live status (kind, scopes, events, strikes, panel) | — | JSON extension list |
| POST | `/v1/extensions/:name/panel` | token: `ui.panel` | Replace the extension's sanitized markdown panel (the sanctioned UI slot; `name` must match the bearer's grant) | JSON {markdown} | JSON {ok} |
| GET | `/v1/liveness` | open | Identity card for a booting sibling: is this daemon Redline, and does it still have a window? (The dev preflight decides retire-vs-refuse on `hasWindow`.) | — | JSON {app: "redline", pid, hasWindow, version} |
| POST | `/v1/admin/shutdown` | token: master only | Gracefully retire this instance (persist, kill children, release :1420/:7676). Called by a booting sibling's preflight against a headless incumbent, authenticated with the on-disk `daemon.token`. | — (empty body) | JSON {ok, pid}; the process runs its exit cleanup and terminates moments later |
| POST | `/v1/prompts/ingest` | hook contract | Polis lake capture: the global UserPromptSubmit hook POSTs its stdin payload (fail-open) | JSON hook payload (prompt, session, cwd) | 200 always (never blocks the hook) |
| GET | `/v1/memory/tree` | open | ClassMemory catalog tree (retrieval walk entry point) | — | JSON class tree |
| GET | `/v1/memory/node/:id` | open | One ClassMemory node with members | node id in path | JSON node detail |
| GET | `/v1/memory/prompts` | open | Prompts under a class (retrieval leaf read) | ?class= node id | JSON prompt list |
| GET | `/v1/memory/answer-pack` | open | Batched retrieval read: node + subtree + links + notes + lexical hits in one call | ?q= term, ?node= node id, ?limit= n | JSON answer pack (byte-bounded) |
| GET | `/v1/memory/grep` | open | Literal/regex search over the record — flags, paths, error strings, attributes | ?q= literal (>= 3 chars, required), ?re= regex, ?case=1, ?scope=prompts/browse/all, ?limit= n | JSON {hits:[{kind, seq, ts, label, excerpt}]}; 400 with a reason when the literal is too short |
| POST | `/v1/memory/proposals` | token: `memory.propose` | Stage reviewable ClassMemory proposal rows (never accepts or moves a node) | JSON structured proposal ops | JSON staged proposal ids |
| GET | `/v1/memory/context` | open | The answer pack rendered as ONE grounding block a model can be handed verbatim (the discussion prefetch's shape) | ?q= question (required), ?node= node id, ?max_tokens= n (default 2000) | JSON {text: markdown block or null, terms:[searched terms]} |
| GET | `/v1/memory/ledger` | open | Faceted timeline page over the chain, newest first (cursor: before_seq) | ?kind=&author=&session=&surface=&project=&q=&since_ts=&until_ts=&before_seq=&limit=&starred=1&noted=1&seqs=1,2&class_node=&thread_id=&browse_id=&role= | JSON {items:[timeline item, …]} |
| GET | `/v1/memory/verify` | open | Re-walk the hash chain genesis→head | — | JSON chain verdict {ok, checked, firstBadSeq, headHash} |
| GET | `/v1/memory/health` | open | Intactness and capability in one read: chain verdict, head seq, counts, the model (null = no model), the embedder, store versions | — | JSON health report |
| GET | `/v1/memory/map` | open | The memory map: classes + threads with declared edge kinds | — | JSON {nodes, edges} |
| POST | `/v1/memory/remember` | token: `memory.write` | Keep one memory: the user's own words (asUser) as a prompt row, or a standalone note | JSON {text, asUser?, project?} | JSON {seq, id} |
| POST | `/v1/memory/annotate` | token: `memory.write` | A note on a ledger seq, a class node or a session | JSON {targetKind, targetId?, text} | JSON {seq, id} |
| POST | `/v1/memory/forget` | token: `memory.forget` | Body → `[forgotten]`; archive, vectors and claims removed; the chain stays green. Requires confirm:"forget" | JSON {targetKind, targetId, confirm:"forget"} | JSON {forgotten, seq}; 400 without the confirmation word |
| POST | `/v1/memory/events` | token: `memory.write` | Batch import of episodes/messages with their own clock; idempotent on (body hash, run) | JSON {items:[{body, ts?, role?, session?, run?, project?}]} | JSON {recorded:[seq, …], skipped} |
| POST | `/v1/memory/browse` | token: `memory.write` | One browsing event (navigate / select / submit / leave) into the lake | JSON {action?, browseId?, url, title?, text, author?} | JSON {seq} (null = consecutive duplicate for the tab) |
| POST | `/v1/memory/organize` | token: `memory.organize` | Run one classifier pass over the lake delta now (drives the model; 503 when no model is configured) | — (empty body) | JSON {ran, autoApplied, summary, seqFrom, seqTo, staged} |
| POST | `/v1/memory/reindex` | token: `memory.organize` | Embed one call's worth of the semantic backlog | — (empty body) | JSON {embedded, provider} (provider "absent" = no embedder, never an error) |
| GET | `/v1/context/prompts` | open | Filtered lake query (bounded, injection-safe LIKE) | ?q=&project=&limit=... | JSON prompt rows |
| GET | `/v1/context/stats` | open | Aggregate lake/catalog stats | — | JSON stats |
| GET | `/v1/context/browse/search` | open | Search captured browsing history | ?q=... | JSON hits |
| GET | `/v1/context/threads/:kind/:id` | open | Generic read of any per-surface message thread (memory-by-session spine) | kind + id in path | JSON message list |
| GET | `/v1/context/tree/:kind/:id` | open | Session-tree walk: a node with parent + child digests | kind + id in path | JSON tree node |

## Scopes

- `plan.suggest` — `POST /v1/sessions/:session_id/suggestions`
- `plan.comment` — `POST /v1/sessions/:session_id/comments`
- `plan.offer` — `POST /v1/sessions/:session_id/comment-offers`
- `browser.drive` — `POST /v1/browser/query`, `POST /v1/browser/navigate`, `POST /v1/browser/click`, `POST /v1/browser/open`, `POST /v1/browser/focus`, `POST /v1/browser/download`
- `consult` — `POST /v1/linked/consult`, `POST /v1/global/consult`
- `memory.propose` — `POST /v1/memory/proposals`
- `memory.write` — `POST /v1/memory/remember`, `POST /v1/memory/annotate`, `POST /v1/memory/events`, `POST /v1/memory/browse`
- `memory.forget` — `POST /v1/memory/forget`
- `memory.organize` — `POST /v1/memory/organize`, `POST /v1/memory/reindex`
- `drafter.suggest` — `POST /v1/drafter/:draft_id/suggestions`
- `review.annotate` — `POST /v1/reviews/annotations`, `DELETE /v1/reviews/annotations`
- `orchestration.report` — `POST /v1/orchestration/report`
- `ui.panel` — `POST /v1/extensions/:name/panel`
- `work.file` — `POST /v1/work`
- `work.claim` — `POST /v1/work/:id/claim`, `POST /v1/work/:id/close`


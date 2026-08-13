# Redline WASM extensions — ABI v1

Generated from `redline-extension-abi` (the crate the host and the SDK both compile against) via `UPDATE_GOLDEN=1 cargo test extensions_doc`. Do not edit by hand.

A `kind: "wasm"` extension is a plain core-wasm module (`wasm32-unknown-unknown`) loaded in-process at every Redline launch. It subscribes to events, and calls back into Redline's local control plane through `host_call` — the same authorized `/v1` surface external extensions reach over HTTP, with the same fail-closed scope checks. There is no WASI: no filesystem, network, environment, or clock.

## Manifest (`extension.json`, v2 fields)

```json
{
  "name": "my-extension",
  "kind": "wasm",
  "module": "extension.wasm",
  "api_version": 1,
  "scopes": ["plan.comment"],
  "events": ["plan.received"]
}
```

`kind` defaults to `"external"` (a local process using the `.token` file); `module` is a bare filename next to the manifest; `api_version` must equal the ABI major version below; `events` must be a subset of the closed vocabulary below.

## ABI

- ABI version: **1**
- Guest exports: `rl_api_version`, `rl_alloc`, `rl_free`, `rl_init`, `rl_on_event` (plus `memory`)
- Host imports (module `redline`): `host_call`, `host_log`

The canonical IDL is `wit/redline-host.wit`, embedded in the ABI crate as `redline_extension_abi::WIT`. All records cross the boundary as UTF-8 JSON in guest linear memory.

## Events

### `plan.received`

A plan arrived for review (the ExitPlanMode hold opened).

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string | plan session id |
| `version` | integer | revision number of the arriving plan |
| `is_new_session` | boolean | first revision of a new session |
| `thread_start` | boolean | fresh plan (vs a feedback revision) |
| `mode` | string | "revise" or "ask" (discuss round-trip) |
| `restored` | boolean | re-presented by the daemon's Restore path |
| `ts_ms` | integer | unix millis at emit |

### `review.started`

A code review opened (or advanced a round) and is holding.

| Field | Type | Meaning |
|---|---|---|
| `review_id` | string | review session id |
| `repo_path` | string | absolute repo path under review |
| `source` | string | which flow opened the review |
| `round` | integer | review round, 1-based |
| `ts_ms` | integer | unix millis at emit |

### `review.annotations_changed`

A live review's external annotations changed.

| Field | Type | Meaning |
|---|---|---|
| `review_id` | string | review session id |
| `ts_ms` | integer | unix millis at emit |

### `comment.offer`

An agent staged an offered plan item (nothing written yet).

| Field | Type | Meaning |
|---|---|---|
| `offer_id` | string | offer id |
| `session_id` | string | plan session id |
| `block_id` | string | null | anchored plan block, if any |
| `body` | string | the offered item's text |
| `agent_id` | string | which agent staged it |
| `ts_ms` | integer | unix millis at emit |

### `ledger.changed`

The append-only prompt/decision ledger grew.

| Field | Type | Meaning |
|---|---|---|
| `ts_ms` | integer | unix millis at emit |

### `suggestion.resolved`

The user resolved a drafter tracked suggestion.

| Field | Type | Meaning |
|---|---|---|
| `suggestion_id` | string | suggestion id |
| `status` | string | "applied" or "rejected" |
| `ts_ms` | integer | unix millis at emit |

Delivery is sequential per extension from a bounded queue (overflow drops the oldest event and records friction). Each delivery runs under a fuel budget; traps, fuel exhaustion, and non-zero returns count as strikes — three strikes disable the extension until relaunch.

## Scopes

- `plan.suggest` — post tracked edit suggestions against plan blocks
- `plan.comment` — write [feedback] comments that ride the next plan revision
- `plan.offer` — stage offered plan items the user taps to accept
- `browser.drive` — drive the embedded browser (navigate, click, query, download)
- `consult` — consult other surfaces' agents for digests
- `memory.propose` — stage reviewable ClassMemory proposals
- `drafter.suggest` — write tracked suggestions into a live draft
- `review.annotate` — post and clear findings in a live code review
- `orchestration.report` — file an orchestrated run's structured exit report
- `ui.panel` — render a sanitized markdown panel in the Extensions view
- `work.file` — file new items into the work graph
- `work.claim` — claim and close work-graph items


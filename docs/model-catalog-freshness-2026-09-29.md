# Model catalog freshness

Redline's picker now reads the installed harness's metadata interface instead of treating model names embedded in an executable as the current catalog. The live Claude metadata check on September 29 returned Opus 5.5 alongside Opus 5; no model-version list was added to Redline.

## Discovery contract

- Claude: the Agent SDK initialize control handshake, with no user message. Model values, display names, descriptions and supported effort levels come from the returned `models` rows. Hooks, MCP servers and session persistence are disabled for discovery; normal harness authentication is retained. No family/version allowlist filters future models.
- Codex: app-server `model/list`, with visible models and advertised effort/default values. Pagination follows `nextCursor`, rejects repeated cursors, and is bounded. The metadata reader has a 2 MiB output cap; the catalog has a 15-second overall deadline. No thread or turn is started.
- Cursor and Antigravity: the existing selected CLI's `models` adapter. The resolved executable is captured before discovery so a changed override cannot replace the source halfway through the request.

These interfaces describe models the harness advertises. A general provider API catalog is not necessarily the set available through a subscription, organization policy, region or third-party harness. A successful check does not guarantee a future generation will be accepted, nor does it bypass the harness's own caching.

## Cache and refresh policy

`src-tauri/src/model_catalog.rs` owns an in-memory cache shared by all picker callers. Successful metadata stays fresh for 30 minutes. Requests occur for the selected harness at initial readiness, picker open, and app focus/visibility return; there is no background polling loop and no hover-triggered discovery. A fresh request performs local identity checks and IPC without launching another metadata process.

Concurrent requests share one refresh. Manual refresh bypasses the successful-cache TTL and failure backoff, with a 10-second cooldown to collapse repeated clicks. Failed or empty responses retain the last good rows and their original checked timestamp. Retry delays begin at 30 seconds and double to a 15-minute cap, evaluated on demand rather than by a timer. The UI stays usable during refresh and shows a warning if revalidation fails.

Cache identity includes the harness, executable path/mtime/length, and, for Claude/Codex, the configured home plus metadata for known settings/auth files. Credential contents are never read into this cache. Changed installations/configuration receive separate entries. Keychain-only account changes, and account changes in adapters without a stable revision interface, are detected on the next eligible check or explicit refresh. This is bounded freshness, not instant account-change notification.

The cache is not persisted across app restarts. Restart performs a selected-harness metadata check. This avoids persisting account-dependent catalog state and eliminates a separate disk cache that can silently outlive its source. Offline last-good retention applies within the current app process.

The picker shows a checked time and a labeled Refresh models action. Catalog refresh does not silently replace a selected pinned model; a missing selection remains visible with an explanation. Explicit model changes still normalize effort against that model's advertised capabilities. Claude models that do not advertise effort do not receive invented effort bars.

## Documented industry interfaces

- [OpenAI Codex app-server model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist) explicitly directs clients to discover models and capability values instead of hard-coding them.
- [Anthropic's Agent SDK initialize implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py) provides the Claude Code control handshake. [Anthropic's Models API](https://platform.claude.com/docs/en/api/models/list) separately discovers API models.
- [Amazon Bedrock model discovery](https://docs.aws.amazon.com/us_en/bedrock/latest/userguide/models-get-info.html) separates foundation model and inference-profile discovery by endpoint.
- [Google models.list](https://ai.google.dev/api/models#method:-models.list) returns a paginated metadata catalog and model capabilities.
- [HTTP cache validation, RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.3) describes conditional validators such as ETag to avoid downloading unchanged responses. Redline's CLI protocols expose no equivalent validator, so conditional HTTP requests are left to the harness rather than inventing an ETag mechanism.

The TTL, coalescing, backoff and last-good policy above are Redline's design choices based on these metadata interfaces; the provider documentation does not establish the providers' private picker-cache policies.

## Verification

- 147 focused frontend tests, including refresh retention, stale replies, concurrent requests, explicit refresh and per-model effort capabilities.
- 6 native catalog tests cover freshness/cooldown/backoff, failure and empty-result retention, unknown future ids/efforts, concurrency and a metadata-only Claude subprocess handshake.
- 14 additional native Codex/provider regression tests passed.
- An explicitly run native metadata smoke test passed against the installed Claude and Codex harnesses: 11 Claude picker entries (including Opus 5.5 and Opus 5), 7 Codex entries. No inference request was sent. Cursor and Antigravity adapters were not authenticated live in this check.
- 168 browser fixture checks at 1440×960, 900×640 and 480×720 passed, including the subsequent front-door shortcut and edge-drag checks. Native macOS interaction remains unverified.

Local desktop build: `rel-1790692838-a382cfd` completed through `scripts/redline-build.sh`, signed with Redline Dev and passed the script's strict signature verification. Bundle: `src-tauri/target/release/bundle/macos/Redline.app`. Prepared only; not installed into `/Applications` or launched.

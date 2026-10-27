# October 6 plan implementation

Working branch: `feature/redline-plans-20261006` in the isolated `redline-wt/plans-20261006` checkout. Preexisting work was committed and pushed on Redline main at `9032117`. Do not run the production dev watcher from this implementation checkout.

> **Structured shell removed, 2026-10-06.** The structured ("hosted") shell row below no longer describes main. It was removed on 2026-10-06: plan launches, approved builds, restores, team builds and Codex sessions all type their command into a raw xterm/PTY tab again, as they did at `9032117`, and the terminal default-view / shell-integration settings are gone. The full implementation is parked on `parked/structured-shell` for a later, different re-implementation. Every other plan in this table is unaffected.

## Scope and current evidence

| Plan | Implementation | Verification so far |
| --- | --- | --- |
| Browser project context | Host/date block; project index and bounded mention cards; remembered per-thread injection; read-only project map; browse skill v8 | Rust: 6 project-context and 12 browse tests passed. Real MachineOS page-agent acceptance remains pending. |
| Chat workbench | Queue tray, mode/project/model picks, native steer, linked Plan/Run continuation, changes/undo | Real Claude/Codex steer spike; focused queue/picker/changes tests |
| Wrong page class filing | Seq-based readers/writer guard/bundles, diverged row-ID fixtures, Polis pin | Polis store/memory/server tests; live read-only SQL: 1,736 filed, 1,736 shown, 0 mismatches |
| Floating native browser after reload | Native hide lifecycle, crash/suspend signals, timeout, atomic create | Browser lifecycle tests; native GUI walk still pending |
| Front Door file drop | Native drop hit-test, merge/dedupe, highlight, focus, terminal occlusion guard | 33 FrontDoor + 7 terminal lifecycle tests |
| Guided Git | Guided/expert pose, deterministic story, audit trail, sync/conflicts, workspaces, recoverable undo, optional narration | 55 frontend tests; real temporary Git repositories and remotes |
| Manual plan state / move repo | State menu, guarded backend transitions, repo modal, transactional storage/work-item move, resume cwd split | State/menu/resume tests; manual transition, repo move and transcript-cwd Rust tests passed |
| Browser refresh | All phases wired: suspend/process recovery, one-shot native creation, left rail/PSL groups, shared/own chat, Task list, inline Ask, new-tab home, floating background Plan/Run | 168 focused frontend tests passed; 135 Chrome fixture checks, 44 screenshots (folder since removed from the repo). Later PSL exception test also passed. Native GUI walk remains pending. |
| Structured shell | Claude/Codex hosted drivers, permission/question cards, transforms/context, raw handoff, shell blocks, settings and all launch paths implemented | Live Claude protocol/permissions/questions/plan loop, workflow approval, native handoff and Codex two-turn checks passed; controlled-model Codex Stop-hook approval passed. Full 12h elapsed timeout and complete native GUI acceptance not measured |
| Localhost status list | Running/recent rows, token styles, small-width hiding, no project thumbnails | 20 unit tests; real component fixtures at 1100/440px in Basic/Aurora, including Run/Open/Stop confirmation callbacks |
| Sidebar repo dropdown | Sessions/code dropdown, separate close buttons, preserved link toggle | 3 focused tests plus visual callback checks for repo/Sessions selection, close isolation, last close, linked navigation and focus restoration |
| Sidecar dual flow | Per-thread mode, explicit Write it up, Reply pill, cards, themed ink figures, skills v4/v3 | 44 discussion/footer/render/state tests; actual Mermaid visual fixture in Studio/Basic/Ocean, 36 total controls checks and 11 screenshots (including Localhost/sidebar extension) |

## Cross-repository commits

Polis hotfix branch `hotfix/browse-link-keyspace` (pushed):
- `3f34f7d`: ledger-sequence filing fix.
- `5c524b3`: post-capture ingest annotation, preserving guard/lineage callbacks and merging additionalContext.
- `953fd5c`: preserves exact citation filters alongside the class filing fix; adds their intersection regression.

Forward-port on local Polis main: `4367ef1`, including HEAD-only scoped filing/forget fixes (`8cf9b0e`). Redline pins all seven Polis crates to `953fd5cf04908807c965ea26c7f1ed03db0f2f5f`; lock refreshed and ingest callback wired. The hotfix is pushed; the forward-port on Polis main remains local.

## Final gate (handoff session, October 6)

Closed after the original session hit its usage limit:

- Shell concurrency review: admission runs under the registry lock and a raw-flagged entry stays occupied until `start` atomically replaces that exact `Arc`, so concurrent resumes cannot admit a second driver. `agent_shell_attach` now snapshots pending permissions before emitting, so the output lock is never taken under the permissions lock.
- Full suites on the final tree: `npx tsc --noEmit` clean; vitest 2,488/2,488 across 245 files; `cargo test --lib` 1,462 passed (17 ignored).
- Clippy (`--all-targets -D warnings`): the four findings on lines this branch added are fixed, plus the `redline-activate` `is_none_or` lint. The remaining 136 findings predate this branch (main has never been clippy-clean; CI does not run clippy).
- Size: see `scripts/size-budget.json` for the reviewed ceiling changes and their measurements.

Still open; these need the real app and cannot be claimed from tests:

- Native GUI walks: browser hide-after-reload, Front Door native file drop, structured shell end to end, and the plan-state/move-repo flows.
- Live "what is Mach?" page-agent acceptance for browser project context.
- The 12h hosted-shell elapsed timeout is not measured.
- Polis: local `main` is fast-forwarded to the forward-port (`4367ef1`, 4 commits ahead of `origin/main`) but not pushed. Redline pins the pushed hotfix `953fd5c`.

Integrated frontend run: 2,478 tests across 242 files passed after fixing early
Git-preference hydration and terminal lifecycle expectations. A final rerun covers
the later shell recovery and first-action chat handoff regressions. The full Rust
workspace suite also passed; late targeted regressions and release checks are being finalized.

Plan controls visual evidence: the fixture run's folder, since removed from the repo (`node scripts/plan-controls-visual-qa.mjs` regenerates it).
The initial header cramped at 430px; the final header wraps its controls onto a
second line. Real Mermaid rendering is transparent/themed in agent cards and
keeps the existing light plate in plan content. Native hit-testing is not covered.


Browser and shell context acceptance audit:

- Browser phases 1–7 are implemented, including automatic grouped-tab naming (strict output validation plus host fallback), deterministic homepage data, suspended/process-death events, bounded probes, off-main PNG encoding, and background island launches. The visual fixture now exercises real vertical drag/overflow/collapse/groups/home/island components; its page pixels and services are synthetic. It does not prove native overlay hit-testing, repeated WebContent termination, or latency under 15 real tabs.
- The reload safety hook hides native browser views on main-document load start. Frontend lifecycle tests cover suspension and exhausted process recreation. The plan's native hide-after-reload acceptance still needs an isolated dev-app walk.
- Project context cards/readers are bounded and allowlisted, skip home/nested roots, and inject cards only for user/mission text mentions. Unit tests cover fallbacks, matching, card deduplication, and maps. No live page agent has yet answered the full “what is Mach?” acceptance scenario from this worktree.
- Shell P6 now resolves plan sections/comments, project text files, tabs and browser selections from typed references or explicit descriptors. Arbitrary client-supplied bodies are rejected. Inspection shows source and bounded content; each queued prompt retains its own chips and memory choice. Two UI tests prove exact visible prompt bytes and per-item queue context; five Rust resolver tests await the final shared cargo pass. Browser selections are supported; no cross-app selection capture is claimed.
- Independent review fixed unknown-session `/restore`, relative shell file links, and live-session reuse after directory grants/settings/effort change. Moved plans retain transcript cwd while new project access is applied through a restart of the same conversation. Two launch-reuse tests and seven shell transform tests pass.

Expanded controls fixture: its results.json (folder since removed from the repo) passed 36/36 checks with 11 screenshots and no runtime errors. Localhost rows remain inside 440px, hide their framework column at narrow widths, render without thumbnails, and preserve exact callbacks. Sidebar repo choices, independent close controls, empty-strip removal, linked navigation and focus restoration are exercised through actual DOM clicks. Native Front Door file drops remain covered by unit/lifecycle tests, not fabricated Chrome drag events.

Independent frontend size review: `docs/frontend-size-review-2026-10-06.md` measures 658,220 B boot JS and 9,345,051 B dist against baseline 651,451 B / 9,080,628 B. The lazy PSL, Guided and shell additions explain the increase; the raw module graph has no duplicated rendered modules or shipped analysis/fixture assets. The unchanged boot ceiling still passes, with only 1,780 B headroom. A final build must remeasure later edits.

The shell context review also fixed stale journal paging: each send takes the newest bounded delta in chronological order and advances its cursor only after successful delivery. A database regression test covers a backlog larger than one page and no replay on the following turn.

## Integration decisions

- Claude hosted mode needs both host permission prompts and the stdio permission tool on the measured CLI. Print-mode plan hooks work, so the native held-review loop is retained.
- A raw Claude/Codex process must exit before the structured driver can resume that transcript. The UI preserves drafts, queued prompts and context while the view changes; driver identity and process ownership are checked independently of the last visible busy flag.
- Codex's measured hook joins input blocks. Its disclosed context uses a separate input block and a one-shot capture guard; the saved human prompt stays byte-identical. Claude receives context through the new post-capture annotation path.
- Empty-chat Plan/Build actions first save a durable source instruction. Retries reuse its nonce, and queued handoffs include the conversation that finished while they waited.
- The release comparison uses a clean worktree at the pushed main commit and the same compiler/dependencies. Startup JS retains its existing ceiling; any shipped-size increase is recorded with measured artifacts and independent review.

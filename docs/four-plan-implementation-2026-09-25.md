# Four-plan implementation — 2026-09-25

Implemented the four supplied plans with three implementation agents and an
independent integration review. Existing checkout changes were preserved;
changes remain uncommitted.

## Changes

| Plan | Implemented behavior |
| --- | --- |
| Blank convenience shell | A sole untouched automatic shell yields its tile to a session launch, including a background restore. Keyboard input, paste, IME and native file drops claim the shell. Explicit menu terminals and shells beside other work remain. |
| Reload diagnosis and hardening | Vite ignores README and docs changes. Terminal ids, tile layout, focus and zoom persist. Views attach to surviving PTYs and replay bounded history; detached terminals have a recovery action. Unmount detaches the view, while explicit close kills the shell. |
| Stale permission rule | Removed only the identified grep allow rule from `.claude/settings.local.json`. |
| Discussion panels | Plan-less plates mask the pane; entering a pane mask closes its preference. Intercepts and explicit controls retain their opening behavior. Voice comments, draft comment loading, tandem remounts and new browser tabs no longer force a closed panel open. |

## Integration corrections

- xterm's `onData` includes automatic terminal replies, contrary to the shell
  plan's assumption. Real user input is distinguished from parser replies. A
  guarded compatibility helper and a test against the installed xterm package
  cover keyboard, paste, IME, DSR and DA behavior.
- Every backend attachment sends an initial replay frame, even when empty.
  Historical queries cannot inject fresh responses into the running shell;
  actual input during replay and subsequent live replies still work.
- Recovery snapshots already-owned terminal ids before replacing a placeholder,
  preventing the same inventory from adding the killed placeholder back.
- Attachment tokens prevent stale cleanup and ACKs from affecting a successor
  view. A stalled renderer suspends delivery with bounded storage and resumes
  when acknowledgments return. Failed initial attachment reaps its child.

## Verification

| Check | Result |
| --- | --- |
| Full Vitest suite | 205 files, 2,204 tests passed |
| Full Cargo suite | 1,408 passed; 15 intentionally ignored |
| PTY regression tests | 25 passed, including a real native PTY retaining its PID, replaying history and delivering new output after reattachment |
| TypeScript | `npx tsc --noEmit` passed |
| Production frontend | `npm run build` passed |
| Native build | `cargo build --manifest-path src-tauri/Cargo.toml` passed |
| Settings JSON | Valid; comparison confirmed only the specified permission entry was removed |
| Vite watcher probe | Loaded the raw README module, touched README and docs, and observed zero doc events while a control-file change was detected |

Validation logs are in `/tmp/redline-four-plans-*.log`. A task-only patch against
the initial dirty checkout is in `/tmp/redline-four-plans-20260925.patch`.

No Redline app instance was running, and none was started. The live GUI
walkthrough and physical webview reload remain unperformed; component lifecycle
tests and the native PTY regression exercise the underlying recovery behavior.
Builds retain existing compiler, CSS minifier and chunk-size warnings.

Recovery preserves processes across a webview reload, not an application exit.
Replay retains the newest 256 KiB of raw output; older history and terminal
state-setting escape sequences outside that bound cannot be reconstructed.

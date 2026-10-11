// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The tiny shared notes of a turn that didn't simply succeed, rendered
// under the row they belong to.
//
// - `UnsentNote` — the send never became a turn (drain-spawn failure, or a
//   queued row orphaned by an app relaunch); offers a one-tap resend.
// - `RetryNote` — the turn ran and failed. Sits under the error row and
//   re-sends the question that produced it, so a transient model error costs
//   a tap instead of retyping.
//
// A send queued behind a running reply is not a note on a row: it waits in
// the tray above the composer (`QueueTray`).
//
// Both are drawn in the accents as text (`.rl-turn-note`, ReplyBlock.css),
// which every theme holds at 4.5:1.

export function RetryNote({ onRetry }: { onRetry: () => void }) {
  return (
    <span className="rl-turn-note">
      <button type="button" onClick={onRetry} title="Send that message again" className="rl-turn-note-action">
        ⟳ Retry
      </button>
    </span>
  );
}

export function UnsentNote({ onResend }: { onResend?: () => void }) {
  return (
    <span className="rl-turn-note">
      wasn't sent
      {onResend && (
        <button type="button" onClick={onResend} title="Send this message again" className="rl-turn-note-action">
          resend
        </button>
      )}
    </span>
  );
}

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

export function RetryNote({ onRetry }: { onRetry: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 mt-0.5 self-start">
      <button
        type="button"
        onClick={onRetry}
        title="Send that message again"
        className="hover:opacity-80"
        style={{
          fontSize: "10.5px",
          fontWeight: 600,
          color: "var(--color-info)",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        ⟳ Retry
      </button>
    </span>
  );
}

export function UnsentNote({ onResend }: { onResend?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 mt-0.5 self-start"
      style={{ fontSize: "10.5px", color: "var(--color-warning)" }}
    >
      wasn't sent
      {onResend && (
        <button
          type="button"
          onClick={onResend}
          title="Send this message again"
          className="hover:opacity-80"
          style={{
            fontSize: "10.5px",
            fontWeight: 600,
            color: "var(--color-info)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          resend
        </button>
      )}
    </span>
  );
}

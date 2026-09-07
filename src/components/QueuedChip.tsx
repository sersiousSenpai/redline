// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The tiny shared affordances of a turn that didn't simply succeed, rendered
// under the bubble it belongs to. Bubble styling stays per-surface; only the
// state chips are shared.
//
// - `QueuedChip` — the send is waiting behind the in-flight turn; × pulls it
//   back out (the composer restores its text).
// - `UnsentNote` — the send never became a turn (drain-spawn failure, or a
//   queued row orphaned by an app relaunch); offers a one-tap resend.
// - `RetryNote` — the turn ran and failed. Sits under the error row and
//   re-sends the question that produced it, so a transient model error costs
//   a tap instead of retyping.

export function QueuedChip({ onUnqueue }: { onUnqueue?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 mt-0.5 self-start">
      <span
        className="inline-flex items-center gap-1 rounded-full"
        style={{
          fontSize: "9.5px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          padding: "1px 7px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink-muted)",
        }}
      >
        Queued
        {onUnqueue && (
          <button
            type="button"
            onClick={onUnqueue}
            title="Remove from the queue and put the text back in the composer"
            className="leading-none hover:opacity-100 opacity-70"
            style={{
              fontSize: "11px",
              color: "var(--color-ink-muted)",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        )}
      </span>
    </span>
  );
}

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

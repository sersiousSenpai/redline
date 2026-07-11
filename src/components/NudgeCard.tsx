// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The one quiet suggestion (see src/lib/nudge.ts). Deliberately understated:
// a small card low in the corner, plain words, two verbs. Never a tour, never
// a wizard, never a badge — the app noticed something, says it once, and
// either way never brings it up again.
export function NudgeCard({
  message,
  onAccept,
  onDismiss,
}: {
  message: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="fixed rounded-md px-3 py-2.5 font-sans"
      style={{
        right: "16px",
        bottom: "52px",
        width: "260px",
        zIndex: 40,
        border: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          lineHeight: 1.45,
          color: "var(--color-ink)",
        }}
      >
        {message}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={onAccept}
          className="rounded-sm px-2 py-0.5"
          style={{
            fontSize: "11px",
            fontWeight: 600,
            border: "1px solid var(--color-rule)",
            background: "var(--color-anchor-bg)",
            color: "var(--color-anchor-text)",
            cursor: "pointer",
          }}
        >
          Make it so
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-sm px-2 py-0.5"
          style={{
            fontSize: "11px",
            border: "1px solid var(--color-rule)",
            background: "transparent",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          No thanks
        </button>
      </div>
    </div>
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
interface AskModeViolationBannerProps {
  onDismiss: () => void;
}

export function AskModeViolationBanner({ onDismiss }: AskModeViolationBannerProps) {
  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: "var(--color-warning)",
        background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
        fontSize: "12px",
        color: "var(--color-ink)",
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span
          style={{
            fontSize: "10px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--color-warning)",
          }}
        >
          Plan modified during Ask
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="opacity-60 hover:opacity-100"
          style={{ color: "var(--color-ink-muted)", fontSize: "12px" }}
        >
          ✕
        </button>
      </div>
      <p style={{ lineHeight: 1.45 }}>
        You asked Claude only questions, but it returned a revised plan
        anyway. This was processed as a normal revision — review the diff.
      </p>
    </div>
  );
}

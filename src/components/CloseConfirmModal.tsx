// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

interface CloseConfirmModalProps {
  /** Proceed with closing the window (tears down all terminals). */
  onConfirm: () => void;
  /** Dismiss and keep the app open. */
  onCancel: () => void;
}

// Shown when the user tries to close Redline while a terminal has navigated
// away from the directory it opened in — closing would silently kill that
// session. Mirrors HookSetupModal's overlay/elevated-card styling so it reads
// as native Redline chrome, not an OS dialog.
export function CloseConfirmModal({
  onConfirm,
  onCancel,
}: CloseConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onCancel}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          maxWidth: "420px",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          Close Redline?
        </h2>
        <p
          style={{
            fontSize: "13px",
            lineHeight: 1.55,
            color: "var(--color-ink)",
            marginBottom: 18,
          }}
        >
          One or more terminals have moved out of their starting directory.
          Closing Redline ends those sessions and any processes running in them.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              background: "var(--color-warning)",
              color: "var(--color-on-accent)",
              fontSize: "12px",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
interface ApproveToastProps {
  message: string;
  /** Colour of the pill. "success" (the default) is the original confirmation
   *  green; "info" marks something that happened *to* you rather than something
   *  you did — notably a plan intercepted for another session. */
  tone?: "success" | "info";
  /** Optional affordance: when a toast reports something the app deliberately
   *  did NOT do on your behalf, it has to offer the way to do it. */
  action?: { label: string; onAction: () => void };
}

export function ApproveToast({
  message,
  tone = "success",
  action,
}: ApproveToastProps) {
  return (
    <div
      className="fixed bottom-12 right-6 rounded-md shadow-lg px-4 py-2 z-50 flex items-center gap-3"
      style={{
        background:
          tone === "info" ? "var(--color-info)" : "var(--color-success)",
        color: "var(--color-on-accent)",
        fontSize: "13px",
        fontWeight: 500,
      }}
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onAction}
          className="rounded px-2 py-0.5 shrink-0"
          style={{
            border: "1px solid var(--color-on-accent)",
            color: "var(--color-on-accent)",
            fontSize: "12px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

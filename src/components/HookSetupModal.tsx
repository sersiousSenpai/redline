// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { HookStatus } from "../types";

interface HookSetupModalProps {
  status: HookStatus;
  onInstall: () => void;
  onSkip: () => void;
}

export function HookSetupModal({
  status,
  onInstall,
  onSkip,
}: HookSetupModalProps) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          maxWidth: "520px",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          Install the Redline hook in Claude Code
        </h2>
        <p
          style={{
            fontSize: "13px",
            lineHeight: 1.55,
            color: "var(--color-ink)",
            marginBottom: 12,
          }}
        >
          Redline intercepts plans via a global hook in{" "}
          <code
            className="font-mono"
            style={{
              background: "var(--color-anchor-bg)",
              padding: "1px 4px",
              borderRadius: "3px",
              fontSize: "12px",
            }}
          >
            {status.settingsPath}
          </code>
          . With the hook installed, every Claude Code session in plan mode will
          surface its plan here for review.
        </p>
        {status.matcherFound && status.conflictingUrl && (
          <p
            style={{
              fontSize: "12px",
              lineHeight: 1.5,
              color: "var(--color-warning)",
              marginBottom: 12,
            }}
          >
            A different ExitPlanMode hook is already configured (
            <code className="font-mono">{status.conflictingUrl}</code>).
            Installing will replace it with the Redline URL.
          </p>
        )}
        <p
          style={{
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--color-ink-muted)",
            marginBottom: 18,
          }}
        >
          After install, run{" "}
          <code
            className="font-mono"
            style={{
              background: "var(--color-anchor-bg)",
              padding: "1px 4px",
              borderRadius: "3px",
              fontSize: "12px",
            }}
          >
            /hooks
          </code>{" "}
          inside Claude Code once to approve the hook (a one-time security
          check).
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="rounded px-3 py-1.5"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={onInstall}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              fontSize: "12px",
            }}
          >
            Install hook
          </button>
        </div>
      </div>
    </div>
  );
}
